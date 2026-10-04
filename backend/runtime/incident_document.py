"""Plain-language incident headings derived from recorded findings."""
import math
import re


def document_details(items, service):
    kinds = ' '.join(str(item.get('kind', '')).lower() for item in items)
    if any(word in kinds for word in ('multiple_lines', 'duplicate')):
        title = 'Possible duplicate payroll payment'
        expectation = 'Each payment should match an approved paycheck or documented split payment.'
    elif any(word in kinds for word in ('terminated_payment', 'paid after termination')):
        title = 'Payment after employee termination'
        expectation = 'Payments after termination should match an authorized final-pay arrangement.'
    elif 'bonus' in kinds:
        title = 'Unexpected payroll bonus'
        expectation = 'Bonus payments should match the approved bonus amount for the employee and pay period.'
    elif 'overtime' in kinds:
        title = 'Unexpected overtime payment'
        expectation = 'Overtime payments should match approved hours and the applicable pay rate.'
    elif any(word in kinds for word in ('deduction', 'health', 'retirement', '401k')):
        title = 'Payroll deduction needs review'
        expectation = 'Deductions should match the employee’s current benefit elections and payroll settings.'
    else:
        title = 'Payroll changes need review' if items else 'Payroll review report'
        expectation = 'Payroll amounts should match approved hours, compensation, deductions and employee records.'
    if len({item.get('employeeId') for item in items if item.get('employeeId')}) > 1 and len({item.get('kind') for item in items}) > 1:
        title = 'Payroll anomalies need review'
        expectation = 'Payroll amounts should match approved hours, compensation, bonuses, deductions and employee records.'
    return {'title': title, 'expectedBehavior': expectation + ' This is a review expectation; approval records and company policy were not supplied.',
            'impactedService': service or 'Not supplied'}


def readable_report(incident, *, currency='USD', conclusion=None):
    """Presentation only: retain full evidence in the incident and artifact JSON."""
    items = [item for item in incident['evidence'] if item.get('kind') != 'decision_model']
    def clean(value):
        return str(value or '').replace('|', '/').replace('\n', ' ').strip()
    def amount(value, unit):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            return 'Not available'
        return f'{value:,.2f} {unit}'
    people = list(dict.fromkeys(clean(item.get('name') or item.get('employeeId')) for item in items if item.get('employeeId')))
    lines = [f"# {incident['title']}", '', '## Impacted service',
             f"{incident['impactedService']} | Payrun {incident['payrunId']}",
             'Employees: ' + (', '.join(people) or 'Whole payrun'), '',
             '## Expected system behavior', incident['expectedBehavior'].split(' This is a review expectation;')[0],
             '', '## What needs review',
             '| Employee | Pay item | Previous baseline | Current | Change |',
             '| --- | --- | --- | --- | --- |']
    seen, notes, actions = set(), [], []
    metrics = {'gross':'Gross pay','net':'Net pay','bonus':'Bonus','retirement401k':'401(k) deduction',
               'health':'Health deduction','overtime':'Overtime hours','regular':'Regular hours','reimbursement':'Reimbursement'}
    for item in items:
        data = item.get('snapshot') or {}
        metric = data.get('metric')
        key = (item.get('employeeId'), metric)
        if metric and key not in seen:
            seen.add(key)
            unit = data.get('unit') or currency
            lines.append('| ' + ' | '.join([clean(item.get('name') or 'Whole payrun'), metrics.get(metric, clean(item['finding']).rstrip('.')),
                amount(data.get('baseline'), unit), amount(data.get('current'), unit), amount(data.get('delta'), unit)]) + ' |')
        elif not metric:
            # Policy bonus/overtime outliers repeat the same measured change.
            kind = str(item.get('kind','')).lower()
            if not any((item.get('employeeId'), m) in seen for m in ('bonus','overtime','reimbursement') if m in kind):
                note = clean(item.get('finding')).rstrip('.')
                if note and note not in notes:
                    notes.append(note)
    if not seen:
        lines = lines[:-2]
    lines += [''] + ['- '+note+'.' for note in notes]
    kinds = ' '.join(str(item.get('kind','')).lower() for item in items)
    for tokens, action in [
        (('bonus',), 'Confirm the bonus amount against the approved bonus record.'),
        (('overtime',), 'Confirm overtime hours and the pay rate against approved time records.'),
        (('duplicate','multiple_lines'), 'Confirm whether multiple payment lines are authorized split payments.'),
        (('termination','terminated','paid after'), 'Confirm final-pay authorization and the employee termination date.'),
        (('health','401k','retirement','deduction'), 'Check deduction settings and whether they apply correctly to this payment.'),
        (('reimbursement',), 'Match the reimbursement to approved expenses.'),
        (('tax','withholding'), 'Verify tax withholding settings for this employee.')]:
        if any(token in kinds for token in tokens):
            actions.append(action)
    if not actions:
        actions.append('Compare the flagged payment with approved hours, compensation and employee records.')
    lines += ['', '## Next steps', *['- '+action for action in actions], '',
              'These are review indicators, not confirmed errors or losses; approval records and company policy were not supplied.']
    if conclusion:
        # Exclude source IDs and trace metadata from older stored appendices.
        summary = re.split(r'\nSource:|\n- Source ', conclusion, maxsplit=1)[0].strip()
        if summary:
            lines += ['', '## Investigation conclusion', summary]
    images = set()
    lines += ['', '## Evidence snapshots']
    for item in incident['evidence']:
        for shot in item.get('screenshots', []):
            src = shot.get('path') or shot.get('dataUrl')
            if src and src not in images:
                images.add(src)
                label = clean(shot.get('label') or 'Evidence').replace('[','').replace(']','')
                lines += ['', f'![{label}]({src})']
    if not images:
        lines.append('No evidence snapshots were captured. See the findings above.')
    return '\n'.join(lines).strip() + '\n'
