import json
import re
from copy import deepcopy


def valid_text(value, limit):
    return isinstance(value, str) and 0 < len(value.strip()) <= limit and not re.search(r"[\x00-\x08\x0b-\x1f]", value)


def validate_answer(text, sources, findings):
    if not isinstance(text, str) or len(text) > 50000:
        raise ValueError("Invalid response")
    parsed = json.loads(text)
    if not isinstance(parsed, dict) or set(parsed) != {"answer", "sourceIds", "findings"} or not valid_text(parsed["answer"], 3000):
        raise ValueError("Invalid answer")
    allowed = {source["id"] for source in sources}
    ids = parsed["sourceIds"]
    if not isinstance(ids, list) or (sources and not ids) or any(not isinstance(identity, str) or identity not in allowed for identity in ids):
        raise ValueError("Invalid citations")
    expected = {finding["id"] for finding in findings}
    comments = parsed["findings"]
    if not isinstance(comments, list) or len(comments) != len(findings):
        raise ValueError("Incomplete findings")
    seen = set()
    for item in comments:
        if (not isinstance(item, dict) or set(item) != {"findingId", "explanation", "reviewAction"}
                or not isinstance(item["findingId"], str) or item["findingId"] not in expected or item["findingId"] in seen
                or not all(valid_text(item[key], 600) for key in ("explanation", "reviewAction"))):
            raise ValueError("Invalid finding")
        seen.add(item["findingId"])
    return {**parsed, "answer": parsed["answer"].strip(), "sourceIds": list(dict.fromkeys(ids))}


def postprocess(evidence, sources, output):
    analysis = deepcopy(evidence)
    status = output.get("modelStatus", "not_configured")
    reason = output.get("reason")
    parsed = None
    if status == "completed":
        try:
            parsed = validate_answer(output.get("text"), sources, evidence["findings"])
        except (ValueError, TypeError, KeyError):
            status, reason = "invalid_response", "The model answer, citations or findings were invalid. Showing calculated evidence only."
    comments = {item["findingId"]: {key: item[key].strip() for key in ("explanation", "reviewAction")} for item in parsed["findings"]} if parsed else {}
    for finding in analysis["findings"]:
        finding["modelComment"] = comments.get(finding["id"])
    lead = f"Payrun {evidence['payrunId']}: {len(evidence['findings'])} review finding(s) across {len(evidence['employees'])} employee(s)."
    details = [lead, evidence["method"]]
    for employee in evidence["employees"]:
        details.append(f"\n{employee['name']} ({employee['employeeId']}): {employee['historyCount']} comparable completed payrun(s).")
        if employee["historyStatus"] != "available":
            details.append("Insufficient history: historical changes cannot be assessed." if not employee["historyCount"] else "Limited history: treat the comparison as preliminary.")
        if employee["missingFields"]:
            details.append("Missing or invalid fields were not compared: " + ", ".join(employee["missingFields"]))
        for finding in analysis["findings"]:
            if finding["employeeId"] == employee["employeeId"]:
                details.append(f"- {finding['label']}: {json.dumps(finding['evidence'])}")
                if finding["modelComment"]:
                    details.extend(finding["modelComment"].values())
    cited = [{key: source.get(key) for key in ("id", "payrunId", "employeeId", "payDate", "topic")} for identity in (parsed["sourceIds"] if parsed else []) for source in sources if source["id"] == identity]
    model_answer = {"summary": parsed["answer"], "sourceIds": parsed["sourceIds"], "sources": cited, "findings": parsed["findings"]} if parsed else None
    if parsed:
        details = [parsed["answer"], "Historical sources:", *[" | ".join(str(v) for v in item.values() if v) for item in cited], "Calculated review:", *details]
    if reason:
        details.append(reason)
    analysis.update(modelStatus=status, modelMessage=reason, modelAnswer=model_answer, details="\n".join(details))
    return {"reply": parsed["answer"] if parsed else lead + " " + (reason or "See the calculated review for details."), "analysis": analysis,
            "citedSourceIds": parsed["sourceIds"] if parsed else []}
