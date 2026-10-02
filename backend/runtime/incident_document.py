"""Plain-language incident headings derived from recorded findings."""


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
    if len({item.get('kind') for item in items}) > 1:
        title = 'Payroll anomalies need review'
        expectation = 'Payroll amounts should match approved hours, compensation, bonuses, deductions and employee records.'
    return {'title': title, 'expectedBehavior': expectation + ' This is a review expectation; approval records and company policy were not supplied.',
            'impactedService': service or 'Not supplied'}
