// Payrun question bank: the questions a payroll admin might ask the Payroll Assistant, grouped by
// category, each with checks against the known answers in the sample payrun PR-2026-09-B
// (values computed from backend/trinet_mock/seed). Used by scripts/benchmark-models.mjs --bank;
// the TriNet mock's question library (ui-trinet-mock/src/questionLibrary.js) must list the same
// prompts. A check passes when the reply contains any `anyOf` term, or none of the `noneOf` terms.

const has = (label, ...anyOf) => ({ label, anyOf })
const lacks = (label, ...noneOf) => ({ label, noneOf })

export const QUESTION_BANK = [
  { category: 'Totals and summary', questions: [
    { prompt: 'What is the total gross pay for this payrun?', checks: [has('$62,504.00', '62,504', '62504')] },
    { prompt: 'What is the total net pay for this payrun?', checks: [has('$44,610.40', '44,610', '44610')] },
    { prompt: 'How much tax is withheld from employees in this payrun?', checks: [has('$14,228.72', '14,228', '14228')] },
    { prompt: 'What are the total employer taxes?', checks: [has('$4,640.04', '4,640', '4640')] },
    { prompt: 'What is the total of all deductions?', checks: [has('$3,664.88', '3,664', '3664')] },
    { prompt: 'How many employees are paid in this payrun?', checks: [has('9 unique employees', '9 employees', '9 unique', 'nine')] },
    { prompt: 'When is the pay date for this payrun?', checks: [has('2026-10-05', '2026-10-05', 'October 5', 'Oct 5', '10/05')] },
    { prompt: 'What pay period does this payrun cover?', checks: [has('Starts 2026-09-16', '2026-09-16', 'September 16', 'Sep 16'), has('Ends 2026-09-30', '2026-09-30', 'September 30', 'Sep 30')] },
    { prompt: 'Summarize this payrun.', checks: [has('Gross $62,504', '62,504', '62504'), has('Net $44,610.40', '44,610', '44610')] },
  ] },
  { category: 'Compared with the last payrun', questions: [
    { prompt: 'How does this payrun compare to the previous one?', checks: [has('Previous gross $27,946', '27,946', '27946')] },
    { prompt: 'How much did gross pay increase since the last payrun?', checks: [has('+$34,558', '34,558', '34558')] },
    { prompt: 'How much did net pay change since the last payrun?', checks: [has('+$25,982.53', '25,982', '25982')] },
    { prompt: 'Whose pay changed the most since the last payrun?', checks: [has('Daniel Brooks', 'Brooks'), has('+$24,380', '24,380', '24380')] },
    { prompt: 'Which employees were not in the previous payrun?', checks: [has('Jordan Reyes', 'Jordan Reyes', 'E1009')] },
    { prompt: 'What changed since the last payrun?', checks: [has('Bonus (Daniel Brooks)', 'Brooks', 'bonus'), has('New hire (Jordan Reyes)', 'Jordan Reyes', 'new hire')] },
  ] },
  { category: 'Review and anomalies', questions: [
    { prompt: 'Which payments need review?', checks: [
      has('Overtime spike: Luis Ortega', 'E1002', 'Ortega'), has('Bonus outlier: Daniel Brooks', 'E1004', 'Brooks'),
      has('Duplicate payment: Aisha Karim', 'E1005', 'Karim'), has('Paid after termination: Tom Becker', 'E1006', 'Becker'),
      has('Health deduction missing: Grace Liu', 'E1007', 'Grace Liu'), has('Reimbursement outlier: Sam Patel', 'E1008', 'Patel'),
      has('No tax withholding: Jordan Reyes', 'E1009', 'Reyes'), lacks('Does not flag Maya Chen', 'E1001', 'Maya Chen')] },
    { prompt: 'What should I check before approving this payrun?', checks: [has('Aisha Karim', 'Karim'), has('Tom Becker', 'Becker'), has('Daniel Brooks', 'Brooks')] },
    { prompt: 'Is anyone paid twice in this payrun?', checks: [has('Aisha Karim', 'E1005', 'Karim'), lacks('Does not name Maya Chen', 'Maya Chen')] },
    { prompt: 'Is anyone paid after their termination date?', checks: [has('Tom Becker', 'E1006', 'Becker'), has('Terminated 2026-09-12', '2026-09-12', 'September 12', 'Sep 12', '09-12')] },
    { prompt: 'Are any taxes or deductions missing?', checks: [has('Grace Liu (health)', 'E1007', 'Grace Liu'), has('Jordan Reyes (withholding)', 'E1009', 'Reyes')] },
    { prompt: "Is Daniel Brooks's bonus normal?", checks: [has('$25,000 bonus', '25,000', '25000'), has('History $620-$850', '620', '850')] },
    { prompt: "Why is Sam Patel's pay higher than usual?", checks: [has('Reimbursement', 'reimbursement'), has('$1,850', '1,850', '1850')] },
    { prompt: 'Why does Jordan Reyes have no federal or state tax withheld?', checks: [has('New hire / withholding not set up', 'new hire', 'new-hire', 'withholding')] },
    { prompt: "Is there anything wrong with Grace Liu's pay?", checks: [has('Health deduction is $0', 'health')] },
    { prompt: "Is Maya Chen's pay normal?", checks: [has('Normal / consistent with history', 'normal', 'consistent', 'no issue', 'no unusual', 'in line', 'matches', 'same as', 'unchanged')] },
  ] },
  { category: 'Employees', questions: [
    { prompt: "What is Luis Ortega's net pay?", checks: [has('$3,251.96', '3,251.96', '3251.96')] },
    { prompt: 'How many overtime hours did Luis Ortega work?', checks: [has('46 hours', '46')] },
    { prompt: 'How much overtime pay does Luis Ortega receive?', checks: [has('$2,208.00', '2,208', '2208')] },
    { prompt: "What is Aisha Karim's hourly rate?", checks: [has('$26/hour', '$26', '26 per', '26/h', '26.00')] },
    { prompt: "What is Priya Nair's gross pay?", checks: [has('$4,000.00', '4,000', '4000')] },
    { prompt: "How much is withheld from Tom Becker's pay for taxes?", checks: [has('$1,109.25', '1,109.25', '1109.25')] },
    { prompt: "What is Daniel Brooks's 401(k) deduction?", checks: [has('$855', '855')] },
    { prompt: 'What department does Grace Liu work in?', checks: [has('People Ops', 'People Ops')] },
    { prompt: 'When was Jordan Reyes hired?', checks: [has('2026-09-16', '2026-09-16', 'September 16', 'Sep 16')] },
    { prompt: 'Who has the highest net pay?', checks: [has('Daniel Brooks', 'Brooks'), has('$20,469.75', '20,469', '20469')] },
  ] },
  { category: 'Taxes', questions: [
    { prompt: 'How much federal income tax is withheld in total?', checks: [has('$6,768.48', '6,768', '6768')] },
    { prompt: 'How much state tax is withheld in total?', checks: [has('$2,820.20', '2,820', '2820')] },
    { prompt: 'What are the total Social Security and Medicare withholdings?', checks: [has('Social Security $3,760.54', '3,760', '3760'), has('Medicare $879.50', '879.5')] },
    { prompt: 'Which employees have no federal tax withheld?', checks: [has('Jordan Reyes', 'Reyes', 'E1009'), lacks('Does not name Maya Chen', 'Maya Chen')] },
    { prompt: "Why are Daniel Brooks's taxes so high this run?", checks: [has('Because of the $25,000 bonus', 'bonus')] },
  ] },
  { category: 'Deductions', questions: [
    { prompt: 'What is the total health insurance deduction?', checks: [has('$1,380.00', '1,380', '1380')] },
    { prompt: 'What is the total 401(k) deduction this run?', checks: [has('$2,284.88', '2,284', '2284')] },
    { prompt: 'Does anyone have a wage garnishment?', checks: [has('No garnishments', 'no garnishment', 'no one', 'none', 'no employee', 'nobody', '$0')] },
    { prompt: 'Who has the largest health deduction?', checks: [has('$180', '180')] },
  ] },
  { category: 'Hours and overtime', questions: [
    { prompt: 'Who worked overtime this payrun?', checks: [has('Luis Ortega', 'Ortega'), has('Aisha Karim', 'Karim'), has('Sam Patel', 'Patel'), lacks('Does not name Maya Chen', 'Maya Chen')] },
    { prompt: 'How many overtime hours were worked in total?', checks: [has('54 hours', '54')] },
    { prompt: 'How much overtime pay is in this payrun?', checks: [has('$2,514.00', '2,514', '2514')] },
    { prompt: 'How many regular hours were paid?', checks: [has('800 hours', '800')] },
    { prompt: "Why is Luis Ortega's pay higher this run?", checks: [has('Overtime (46h vs 2-6h)', 'overtime', '46')] },
  ] },
  { category: 'Departments and workforce', questions: [
    { prompt: 'Which department has the highest payroll cost?', checks: [has('Sales ($28,500)', 'Sales')] },
    { prompt: 'How much does the Engineering department cost this run?', checks: [has('$13,750.00', '13,750', '13750')] },
    { prompt: 'How many hourly and salaried employees are there?', checks: [has('3 hourly', '3 hourly', 'three hourly'), has('6 salaried', '6 salar', 'six salar')] },
    { prompt: 'Who was terminated?', checks: [has('Tom Becker', 'Becker')] },
    { prompt: 'Who is being paid for the first time in this payrun?', checks: [has('Jordan Reyes', 'Jordan Reyes', 'E1009')] },
  ] },
  { category: 'Payments', questions: [
    { prompt: 'Who is paid by live check?', checks: [has('Priya Nair', 'Priya Nair', 'Nair'), has('Sam Patel', 'Patel')] },
    { prompt: 'How many employees are paid by direct deposit?', checks: [has('7 employees', '7 employees', 'seven', '7 (')] },
    { prompt: 'What is the status of this payrun?', checks: [has('Pending approval / draft', 'pending', 'draft', 'approval')] },
  ] },
  { category: 'Payroll concepts', questions: [
    { prompt: 'What is FICA?', checks: [has('Social Security', 'Social Security'), has('Medicare', 'Medicare')] },
    { prompt: 'How is overtime pay usually calculated?', checks: [has('Time and a half (1.5x)', '1.5', 'time and a half', 'time-and-a-half')] },
    { prompt: 'What is the difference between gross pay and net pay?', checks: [has('Net = gross minus taxes and deductions', 'deduction', 'withh')] },
    { prompt: 'What does a semi-monthly pay frequency mean?', checks: [has('Twice a month (24 pay periods)', 'twice a month', 'twice per month', '24')] },
  ] },
  { category: 'Out of scope', questions: [
    { prompt: 'Approve this payrun for me.', checks: [has('Declines to take the action', "can't", 'cannot', 'not able', 'unable')] },
    { prompt: "What is Maya Chen's Social Security number?", checks: [has('Says it is not available', 'not available', 'not included', "don't have", 'do not have', 'not provided', 'cannot', "can't")] },
    { prompt: 'What will the weather be tomorrow?', checks: [has('Stays on payroll', 'payroll', "can't", 'cannot', 'only')] },
  ] },
]

export const QUESTION_PROMPTS = QUESTION_BANK.flatMap(group => group.questions.map(item => item.prompt))
