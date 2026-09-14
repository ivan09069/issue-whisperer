const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac } = require('node:crypto');
const vm = require('node:vm');

function load(secret) {
  const handlers = {}; const calls = {ai:0, comments:0, schedules:0};
  const app = {use(){}, get(){}, post(path,fn){handlers[path]=fn;}, listen(){throw Error('test opened listener');}};
  const express = Object.assign(() => app, {raw(){},json(){}});
  const logger = {info(){},warn(){},error(){}};
  const modules = {
    express,
    crypto: require('node:crypto'),
    winston: {createLogger:()=>logger, format:{combine(){},timestamp(){},json(){}},transports:{Console:class{}}},
    '@octokit/rest': {Octokit:class {constructor(){this.rest={issues:{async addLabels(){},async createComment(){calls.comments++;}}};}}},
    'node-cron': {schedule(){calls.schedules++;}},
    openai: class {constructor(){this.chat={completions:{async create(){calls.ai++; return {choices:[{message:{content:JSON.stringify({label:'bug',dupe:'None',draft:'Fixture response'})}}]};}}};}},
    stripe: class {}, redis:{createClient(){throw Error('Redis unexpectedly initialized');}},
  };
  const module = {exports:{}};
  const requireFake = name => {if (!(name in modules)) throw Error('Unexpected dependency'); return modules[name];};
  const sandbox = {require:requireFake,module,Buffer,console,process:{env:{GITHUB_WEBHOOK_SECRET:secret}},fetch(){throw Error('network forbidden');}};
  vm.runInNewContext(readFileSync(__dirname+'/app.js','utf8'),sandbox,{filename:'app.js'});
  return {handlers,calls};
}
function request(secret, mutate = false, repo = 'issue-whisperer') {
  const body = {action:'opened',repository:{owner:{login:'ivan09069'},name:repo},issue:{number:1,title:'Fixture issue',body:'Fixture body'}};
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256='+createHmac('sha256',secret).update(rawBody).digest('hex');
  return {body,rawBody:mutate ? Buffer.from('{}') : rawBody,get(name){return {'X-Hub-Signature-256':signature,'X-GitHub-Event':'issues'}[name];}};
}
function response() {return {code:200,body:null,status(n){this.code=n;return this;},json(value){this.body=value;return this;}};}
test('missing webhook secret fails closed without AI or GitHub side effects', async () => {
  const {handlers,calls}=load(undefined),res=response();
  await handlers['/webhook'](request('fixture-secret'),res);
  assert.equal(res.code,503);assert.equal(calls.ai,0);assert.equal(calls.comments,0);assert.equal(calls.schedules,0);
});
test('tampered signature and disallowed repository are rejected before side effects', async () => {
  const {handlers,calls}=load('fixture-secret');
  for (const [req,code] of [[request('fixture-secret',true),401],[request('fixture-secret',false,'other'),403]]) {
    const res=response();await handlers['/webhook'](req,res);assert.equal(res.code,code);
  }
  assert.equal(calls.ai,0);assert.equal(calls.comments,0);
});
test('valid delivery returns success after commenting; repeat does not comment again', async () => {
  const {handlers,calls}=load('fixture-secret');
  for(let i=0;i<2;i++){const res=response();await handlers['/webhook'](request('fixture-secret'),res);assert.equal(res.code,200);}
  assert.equal(calls.comments,1);assert.equal(calls.ai,1);
});
test('concurrent duplicate delivery cannot post two comments', async () => {
  const {handlers,calls}=load('fixture-secret');const a=response(),b=response();
  await Promise.all([handlers['/webhook'](request('fixture-secret'),a),handlers['/webhook'](request('fixture-secret'),b)]);
  assert.equal(calls.comments,1);assert.deepEqual([a.code,b.code].sort(),[200,409]);
});
