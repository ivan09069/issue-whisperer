#!/usr/bin/env python3
"""Groq Issue Analyzer for Issue Whisperer"""
import sys
import json
import os
from openai import OpenAI

def analyze_issue(title: str, body: str = "") -> dict:
    """Analyze a GitHub issue using Groq and return triage suggestions."""
    
    # Support both Groq and XAI
    api_key = os.getenv("GROQ_API_KEY") or os.getenv("XAI_API_KEY")
    base_url = "https://api.groq.com/openai/v1" if os.getenv("GROQ_API_KEY") else "https://api.x.ai/v1"
    model = os.getenv("AI_MODEL", "llama-3.3-70b-versatile")
    
    client = OpenAI(api_key=api_key, base_url=base_url)
    
    prompt = f"""Analyze this GitHub issue and provide triage suggestions.

Title: {title}
Body: {body or '(No description provided)'}

Return a JSON object with exactly these fields:
- "label": One of "bug", "enhancement", "question", "documentation", or "triage" (if unclear)
- "dupe": "None" or "#<issue_number>" if it seems like a duplicate
- "draft": A brief, helpful response to the issue author (1-2 sentences)

Be concise and helpful. If it's clearly a bug report, label it "bug". 
If it's a feature request, label it "enhancement".
If it's a question about usage, label it "question"."""

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=200,
            temperature=0.1
        )
        result = json.loads(response.choices[0].message.content)
        
        # Validate and normalize
        valid_labels = {"bug", "enhancement", "question", "documentation", "triage"}
        label = result.get("label", "triage").lower()
        if label not in valid_labels:
            label = "triage"
            
        return {
            "label": label,
            "dupe": result.get("dupe", "None"),
            "draft": result.get("draft", "Thanks for reporting! We'll review this shortly.")
        }
        
    except Exception as e:
        print(f"Analysis error: {e}", file=sys.stderr)
        return {
            "label": "triage",
            "dupe": "None", 
            "draft": "Thanks for reporting! Our team will review this shortly."
        }

if __name__ == "__main__":
    title = sys.argv[1] if len(sys.argv) > 1 else "Test Issue"
    body = sys.argv[2] if len(sys.argv) > 2 else ""
    
    result = analyze_issue(title, body)
    
    # Output format expected by app.js
    print(result["label"])
    print(result["dupe"])
    print(result["draft"])
