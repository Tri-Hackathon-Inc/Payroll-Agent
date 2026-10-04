AGENT STUDIO  --> CREATE / USE AGENT TEMPLATE --> ADD CONFIGURTION/ MODEL --> ATTACH TOOLS TO AGENT -->

<trinet-domain>/payroll/trinetpay. --> GITHUB

Payrun - Agent <trinet-domain>.   <trinet-domain>/<trinet-agent-factory>

MIcroservice  --> 


ITEM 1
DB 
 1. agent-name
 2. model_used
 3. Type_of_agent

FORM 1 [UI] /save --> /create-agent 
1. AGENT DESCRIPTION /
2. QUESTIONS
3. MODEL TYPE [OS]
4. PAge To Attach 
5. General Query / Comprehension Agent 
6. Tools Attached --
7. Domain - Payrun

Agent-tYpe
Summarizer
General Query
Anomaly Detection

ITEM2
BE - /create-agent --> Anomaly_detection_payrun_agennt --> Service_name [Config]
       /get-agent_by_service/
       
Use HF - Create Agent Factory
Model Configs
Create Agent Template
Select Agent 
Attach Agent to Payrun. Service


ITEM3: CONNECTING TO SERVICE AGENT
W'iRE THE SPECIFIC AGENT TO YOUR FLOW
<trinet-domain>/payroll/trinetpay/<create-agent> [optional, Re-routing to <trinet-domain>/<trinet-agent-factory>]

<trinet-domain>/payroll/trinetpay>
List Payrun  --> Agent Window 
Landing page     -- Agent Window is available
Anomaly Detection Agent --> On real time basis --> open long running connection --> the input will be verified 
and compared with historical data and flag and alerts. 
General Question 

Summarizer page --> Summarizer Agent will fetch the data based on employee detail on a payrun from BE
UI will render this data. 




 
