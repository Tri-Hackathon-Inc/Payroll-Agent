"""Read-only local-stack smoke check; does not confirm a question or invoke a provider."""
import http.cookiejar
import json
from urllib.request import HTTPCookieProcessor, Request, build_opener

opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))


def post(url, value):
    with opener.open(Request(url, json.dumps(value).encode(), {"Content-Type": "application/json"}), timeout=120) as response:
        return json.load(response)


api = "http://backend:4000/"
catalog = post(api, {"query": "{ viewer { role } listDomains { name } }"})
assert not catalog.get("errors"), catalog.get("errors")
domain = next(item["name"] for item in catalog["data"]["listDomains"] if item["name"] == "payroll-services")
registered = post(api, {"query": "query($domain:String!){getServiceAgentRegistry(domainName:$domain){id config}}", "variables": {"domain": domain}})
assert not registered.get("errors"), registered.get("errors")
agents = registered["data"]["getServiceAgentRegistry"]
payroll_url = "http://trinet-mock:4100/"
query = '{ payrun(id:"PR-2026-09-B") { id version lines { lineId employeeId payType hours { overtime } } } }'
current = post(payroll_url, {"query": query})["data"]["payrun"]
line = next(item for item in current["lines"] if item["payType"] == "hourly")
preview = post(api+"events/preview", {"payrunId": current["id"], "lineId": line["lineId"], "expectedVersion": current["version"], "changes": {"hours": {"overtime": 180}}})
assert preview["saved"] is False and preview["analysis"]["findings"]
assert post(payroll_url, {"query": query})["data"]["payrun"] == current
if agents:
    proposal = post(api+f"webhook/{domain}/{agents[0]['id']}", {"question": "Why did net pay change?", "context": {"page": "payrun", "payrunId": current["id"], "employeeId": line["employeeId"]}})
    assert proposal["status"] == "confirmation_required" and proposal["questionMapping"]["candidates"]
    assert proposal["model"] is None
    print("Live GraphQL/gRPC, draft preview, question mapping and no-save checks passed.")
else:
    print("Live GraphQL/gRPC, draft preview and no-save checks passed; no saved agent available for question mapping.")
