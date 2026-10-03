"""Plain-language chat presentation after structured answer validation."""
import re


def chat_reply(result, evidence, question):
    analysis = result.get("analysis", {})
    if analysis.get("modelStatus") == "completed":
        return result["reply"]
    lead = "I couldn't validate an AI explanation. "
    if re.search(r"\bbonus\b", question, re.I):
        statements = []
        currency = evidence.get("currency", "")
        for employee in evidence.get("employees", []):
            comparison = employee.get("comparisons", {}).get("bonus")
            name = employee.get("name") or employee["employeeId"]
            if comparison:
                values = [item["value"] for item in comparison.get("history", [])]
                baseline = comparison["baseline"]
                history = f"{min(values):,.2f}–{max(values):,.2f}" if values else f"{baseline:,.2f}"
                statements.append(f"{name}'s bonus is {currency} {comparison['current']:,.2f}; comparable past bonuses were {currency} {history}.")
            else:
                statements.append(f"There isn't enough comparable bonus data for {name} to judge whether it is unusual.")
            if len(statements) == 3:
                break
        return lead + " ".join(statements or ["Comparable bonus data is unavailable."]) + " Verify the approved bonus before changing pay."
    findings = evidence.get("findings", [])
    if findings:
        facts = "; ".join(f"{item.get('employeeName') or item.get('employeeId')}: {item['label']}" for item in findings[:2])
        return lead + "Calculated checks show: " + facts + ". Check the payroll records to confirm these changes are expected."
    return lead + "The calculated checks found no flagged changes in this scope. This does not confirm that every payment is correct."
