import { test, expect } from '@playwright/test'

test('admin creates, edits and revokes service access through the UI', async ({ page }) => {
  const base = process.env.STUDIO_TEST_URL || 'http://ui:5173/ai_studio/'
  const suffix = Date.now().toString()
  const groupName = `UI test agents ${suffix}`, roleName = `UI test readers ${suffix}`
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  await page.getByRole('button', { name: 'Access control', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Access control', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save agent group' })).toBeVisible()
  const domain = await page.locator('#domain').inputValue()
  const graphql = async (query, variables) => {
    const response = await page.request.post(new URL('graphql', base).href, {data:{query,variables}})
    const body = await response.json()
    expect(body.errors).toBeUndefined()
    return body.data
  }
  const state = async () => (await graphql('query($domainName:String!){agentAccess(domainName:$domainName)}', {domainName:domain})).agentAccess
  const change = async input => graphql('mutation($input:JSON!){manageAgentAccess(input:$input)}', {input:{domainName:domain,...input}})
  try {
    await page.getByLabel('Group name', {exact:true}).fill(groupName)
    await page.getByRole('button', {name:'Save agent group',exact:true}).click()
    await expect(page.getByRole('button', {name:`${groupName} (0)`,exact:true})).toBeVisible()
    await page.getByLabel('Role name', {exact:true}).fill(roleName)
    await page.getByLabel('Read payrun', {exact:true}).check()
    await page.getByRole('button', {name:'Save role group',exact:true}).click()
    await expect(page.getByRole('button', {name:roleName,exact:true})).toBeVisible()
    await page.getByLabel('Agent group', {exact:true}).selectOption({label:groupName})
    await page.getByLabel('Role group', {exact:true}).selectOption({label:roleName})
    await page.getByRole('button', {name:'Grant access',exact:true}).click()
    const mapping = page.locator('div.border-top').filter({hasText:groupName})
    await expect(mapping).toContainText(roleName)
    const saved = await state()
    expect(saved.roleGroups.find(x=>x.name===roleName).permissions.find(x=>x.service==='payrun')).toEqual({service:'payrun',read:true,write:false})
    await page.getByRole('button', {name:roleName,exact:true}).click()
    await page.getByLabel('Read payrun', {exact:true}).uncheck()
    await page.getByLabel('Write payrun', {exact:true}).check()
    await page.getByRole('button', {name:'Save role group',exact:true}).click()
    await expect(page.getByRole('status')).toContainText('Access settings saved')
    await mapping.getByRole('button', {name:'Revoke',exact:true}).click()
    await expect(mapping).toHaveCount(0)
    await page.screenshot({path:'/workspace/.local-data/ui-previews/access-control.png',fullPage:true})
    expect(errors).toEqual([])
  } finally {
    const current = await state()
    for(const group of current.agentGroups.filter(x=>x.name===groupName)) await change({action:'deleteAgentGroup',id:group.id})
    for(const role of current.roleGroups.filter(x=>x.name===roleName)) await change({action:'deleteRoleGroup',id:role.id})
  }
})


test('template configuration saves API access groups with a new agent', async ({page}) => {
  const base = process.env.STUDIO_TEST_URL || 'http://ui:5173/ai_studio/'
  const suffix = Date.now().toString(), groupName = `Template group ${suffix}`, roleName = `Template role ${suffix}`, agentName = `Template agent ${suffix}`
  const domain = 'payroll-services'
  const graphql = async (query, variables) => {
    const response = await page.request.post(new URL('graphql',base).href,{data:{query,variables}})
    const result = await response.json(); expect(result.errors).toBeUndefined(); return result.data
  }
  const change = async input => (await graphql('mutation($input:JSON!){manageAgentAccess(input:$input)}',{input:{domainName:domain,...input}})).manageAgentAccess
  const state = async () => (await graphql('query($domainName:String!){agentAccess(domainName:$domainName)}',{domainName:domain})).agentAccess
  try {
    let data = await change({action:'roleGroup',name:roleName,permissions:[{service:'payrun',read:true,write:false}]})
    const role = data.roleGroups.find(r=>r.name===roleName)
    await change({action:'agentGroup',name:groupName,agentIds:[],roleGroupIds:[role.id]})
    await page.goto(base)
    await page.locator('.service-card').filter({has:page.getByText('Payroll',{exact:true})}).click()
    await page.locator('.template-card').filter({has:page.getByRole('heading',{name:'General Query',exact:true})}).getByRole('button',{name:'Use Template'}).click()
    await page.getByLabel('Agent name',{exact:true}).fill(agentName)
    await page.getByRole('checkbox',{name:'Read API employee-details',exact:true}).check()
    const sources = page.getByRole('checkbox',{name:/Read context from/})
    const sourceCount = Math.min(2,await sources.count())
    for(let i=0;i<sourceCount;i++) await sources.nth(i).check()
    await page.getByRole('checkbox',{name:'Assign role '+roleName,exact:true}).check()
    await page.locator('summary').filter({hasText:'Access groups'}).click()
    await page.getByLabel(groupName,{exact:true}).check()
    const permissions = page.getByRole('region',{name:'Agent permissions'})
    const get = permissions.locator('tr').filter({hasText:'Payrun service'}).filter({hasText:'GET'})
    const post = permissions.locator('tr').filter({hasText:'Payrun service'}).filter({hasText:'POST'})
    await expect(get).toContainText(groupName)
    await expect(post).toContainText('Not granted')
    await page.screenshot({path:'/workspace/.local-data/ui-previews/template-api-permissions.png',fullPage:true})
    await page.getByRole('button',{name:'Create agent',exact:true}).click()
    await expect(page.getByRole('status').or(page.getByRole('alert')).filter({hasText:agentName})).toBeVisible()
    data = await state()
    const agent = data.agents.find(a=>a.name===agentName)
    expect(agent).toBeDefined()
    expect(data.agentGroups.find(g=>g.name===groupName).agentIds).toContain(agent.id)
    expect(data.roleAssignments).toContainEqual({agentId:agent.id,roleGroupId:role.id})
    expect(data.apiPermissions.some(p=>p.agentId===agent.id&&p.service==='employee-details'&&p.read)).toBe(true)
    expect(data.contextPermissions.filter(p=>p.readerId===agent.id)).toHaveLength(sourceCount)
    expect(data.contextPermissions.filter(p=>p.sourceId===agent.id)).toHaveLength(0)
    await page.getByRole('button',{name:'Access control',exact:true}).click()
    await page.getByRole('button',{name:`${groupName} (1)`,exact:true}).click()
    await expect(page.getByLabel(roleName,{exact:true})).toBeChecked()
    await page.getByLabel(roleName,{exact:true}).uncheck()
    await page.getByRole('button',{name:'Save agent group',exact:true}).click()
    await expect(page.getByRole('status')).toContainText('Access settings saved')
    data = await state()
    const group = data.agentGroups.find(g=>g.name===groupName)
    expect(data.authorizations.some(a=>a.agentGroupId===group.id)).toBe(false)
  } finally {
    const data = await state()
    for(const agent of data.agents.filter(a=>a.name===agentName)) await graphql('mutation($id:ID!,$domainName:String!){deleteAgent(id:$id,domainName:$domainName)}',{id:agent.id,domainName:domain})
    for(const group of data.agentGroups.filter(g=>g.name===groupName)) await change({action:'deleteAgentGroup',id:group.id})
    for(const role of data.roleGroups.filter(r=>r.name===roleName)) await change({action:'deleteRoleGroup',id:role.id})
  }
})


test('the first agent has API controls and no context sources', async ({page}) => {
  const base = process.env.STUDIO_TEST_URL || 'http://ui:5173/ai_studio/'
  await page.route('**/graphql',async route=>{
    if(!route.request().postDataJSON().query.includes('agentAccess('))return route.continue()
    return route.fulfill({json:{data:{agentAccess:{agents:[],services:[],agentGroups:[],roleGroups:[],authorizations:[],apiPermissions:[],contextPermissions:[]}}}})
  })
  await page.goto(base)
  await page.locator('.service-card').filter({has:page.getByText('Payroll',{exact:true})}).click()
  await page.locator('.template-card').filter({has:page.getByRole('heading',{name:'Anomaly Detection',exact:true})}).getByRole('button',{name:'Use Template'}).click()
  await expect(page.getByLabel('Description',{exact:true})).toBeVisible()
  const order = await page.locator('#description, #instructions, #app-attachment, #api-source').evaluateAll(elements=>elements.map(e=>e.id))
  expect(order).toEqual(['description','instructions','app-attachment','api-source'])
  await page.getByRole('navigation',{name:'Agent setup sections'}).getByRole('button',{name:/Agent details/}).click()
  await expect(page.locator('#agent-basics')).toBeFocused()
  await page.screenshot({path:'/workspace/.local-data/ui-previews/agent-form-redesign.png',fullPage:true})
  await page.getByLabel('App',{exact:true}).selectOption('')
  await expect(page.getByText('Payrun app UI',{exact:true})).toHaveCount(0)
  await page.getByLabel('App',{exact:true}).selectOption('payrun')
  await expect(page.getByText('Payrun app UI',{exact:true})).toBeVisible()
  await expect(page.getByLabel('Backend API source')).toHaveValue('payrun')
  await page.getByLabel('Backend API source').selectOption('external')
  await expect(page.getByRole('checkbox',{name:'Write API slack-webhook',exact:true})).toBeVisible()
  await expect(page.getByRole('checkbox',{name:'Read API payrun',exact:true})).toHaveCount(0)
  await page.getByLabel('Backend API source').selectOption('payrun')
  await expect(page.getByRole('checkbox',{name:'Read API payrun',exact:true})).toBeVisible()
  await expect(page.getByRole('checkbox',{name:'Read API employee-details',exact:true})).toBeVisible()
  await expect(page.getByText(/No other agents are available/)).toBeVisible()
  await expect(page.getByRole('checkbox',{name:/Read context from/})).toHaveCount(0)
  await expect(page.getByText('Payroll API access is incomplete.',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Allow required payroll Read access',exact:true}).click()
  for(const id of ['payrun','payrun-history','employee-details']){
    await expect(page.getByRole('checkbox',{name:'Read API '+id,exact:true})).toBeChecked()
  }
  await expect(page.getByRole('checkbox',{name:'Write API payrun',exact:true})).not.toBeChecked()
  await expect(page.getByText('Payroll API access is incomplete.',{exact:true})).toHaveCount(0)
})
