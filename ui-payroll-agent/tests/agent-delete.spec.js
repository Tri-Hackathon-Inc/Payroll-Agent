import {test, expect} from '@playwright/test'

test('checkbox deletion supports cancel, filtered selection, and partial failure retry',async({page})=>{
  const base=process.env.STUDIO_TEST_URL||'http://ui:5173/ai_studio/'
  let agents=['First','Second','Other'].map((name,i)=>({id:`fake-delete-${i}`,name:`${name} test agent`,domainName:'payroll-services',templateId:'general-query',templateVersion:1,config:{description:'Test fixture',model:'poc-demo',service:'payrun',page:'payrun'},modelConfig:{name:'Demo'}}))
  let fail=true
  const deleted=[]
  await page.route('**/graphql',async route=>{
    const body=route.request().postDataJSON()
    if(body.query.includes('deleteAgent(')){
      const id=body.variables.id
      expect(id).toMatch(/^fake-delete-/)
      deleted.push(id)
      if(id==='fake-delete-1'&&fail)return route.fulfill({json:{errors:[{message:'Temporary failure'}]}})
      agents=agents.filter(a=>a.id!==id)
      return route.fulfill({json:{data:{deleteAgent:true}}})
    }
    if(body.query.includes('GetServiceAgentRegistry'))return route.fulfill({json:{data:{getServiceAgentRegistry:agents}}})
    if(body.query.includes('agentHealth'))return route.fulfill({json:{data:{agentHealth:{items:[]}}}})
    return route.continue()
  })
  await page.goto(base)
  await page.getByRole('button',{name:'My Agents',exact:true}).click()
  await page.getByRole('checkbox',{name:'Select First test agent',exact:true}).check()
  page.once('dialog',dialog=>dialog.dismiss())
  await page.getByRole('button',{name:'Delete selected (1)',exact:true}).click()
  expect(deleted).toEqual([])
  await page.getByRole('searchbox',{name:'Search agents'}).fill('test agent')
  await expect(page.getByRole('button',{name:'Delete selected (0)',exact:true})).toBeDisabled()
  await page.getByRole('checkbox',{name:'Select all visible agents'}).check()
  await page.getByRole('checkbox',{name:'Select Other test agent',exact:true}).uncheck()
  page.once('dialog',async dialog=>{
    expect(dialog.message()).toContain('First test agent')
    expect(dialog.message()).toContain('Second test agent')
    expect(dialog.message()).not.toContain('Other test agent')
    await dialog.accept()
  })
  await page.getByRole('button',{name:'Delete selected (2)',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Temporary failure')
  await expect(page.getByRole('checkbox',{name:'Select First test agent',exact:true})).toHaveCount(0)
  await expect(page.getByRole('checkbox',{name:'Select Second test agent',exact:true})).toBeChecked()
  await expect(page.getByRole('checkbox',{name:'Select Other test agent',exact:true})).not.toBeChecked()
  fail=false
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Delete selected (1)',exact:true}).click()
  await expect(page.getByRole('checkbox',{name:'Select Second test agent',exact:true})).toHaveCount(0)
  await expect(page.getByRole('checkbox',{name:'Select Other test agent',exact:true})).toBeVisible()
  expect(deleted).toEqual(['fake-delete-0','fake-delete-1','fake-delete-1'])
})
