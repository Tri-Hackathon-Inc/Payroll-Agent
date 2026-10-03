import {test,expect} from '@playwright/test'

test('General Query is live in Studio and through the Payrun API proxy',async({page})=>{
  for(const base of ['http://ui:5173/ai_studio/']){
    await page.goto(base)
    await page.getByRole('button',{name:'My Agents',exact:true}).click()
    const row=page.locator('.my-agent-row').filter({has:page.getByText('General Query',{exact:true})})
    await expect(row.locator('app-agent-health [role="status"]')).toHaveText('Live')
    await row.getByRole('button',{name:'Check connection for General Query'}).click()
    await expect(row.locator('app-agent-health [role="status"]')).toHaveText('Live')
  }
  const response=await page.request.post('http://trinet-ui:5174/trinet/agent-studio/graphql',{data:{query:'{ agentHealth(domainName: "payroll-services") }'}})
  const result=await response.json()
  expect(result.data.agentHealth.items.find(a=>a.agentName==='General Query').status).toBe('live')
  await page.screenshot({path:'/workspace/.local-data/ui-previews/general-query-live.png',fullPage:true})
})

test('failed health reason is visible and manual refresh recovers',async({page})=>{
  let live=false
  await page.route('**/graphql',async route=>{
    const body=route.request().postDataJSON()
    if(!body.query.includes('query AgentHealth'))return route.continue()
    return route.fulfill({json:{data:{agentHealth:{items:[{status:live?'live':'not_connected',reason:live?'Connected to saved AD context.':'Service read access is not granted.',checkedAt:new Date().toISOString()}],scope:'Test health'}}}})
  })
  await page.goto('http://ui:5173/ai_studio/')
  await page.getByRole('button',{name:'My Agents',exact:true}).click()
  const row=page.locator('.my-agent-row').filter({has:page.getByText('General Query',{exact:true})})
  await expect(row.locator('.health-reason')).toHaveText('Service read access is not granted.')
  live=true
  await row.getByRole('button',{name:'Check connection for General Query'}).click()
  await expect(row.locator('app-agent-health [role="status"]')).toHaveText('Live')
  await expect(row.locator('.health-reason')).toHaveCount(0)
})
