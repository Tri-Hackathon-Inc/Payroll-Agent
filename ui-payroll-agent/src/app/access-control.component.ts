import { Component, Input, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { Domain, errorMessage } from './models';
import { AccessState as State, AccessPermission as Permission, AccessGroup as Group, AccessRole as Role, ApiOperation } from './agent-access.models';
@Component({selector: 'app-access-control', standalone: true, imports: [FormsModule], template: `
<section aria-labelledby="access-title">
<h2 id="access-title" class="h4"><i class="bi bi-shield-lock me-2" aria-hidden="true"></i>Access control</h2>
<p class="text-muted">Agent groups &rarr; Role groups &rarr; Service API permissions. Unmapped agents have no service access. Read and Write are independent.</p>
@if (error) { <div class="alert alert-danger" role="alert">{{error}}</div> }
@if (notice) { <p class="alert alert-success" role="status">{{notice}}</p> }
@if (!state) { <button class="btn btn-outline-dark" [disabled]="busy" (click)="load()">{{busy ? 'Loading...' : 'Retry'}}</button> }
@if (state; as data) {
<fieldset [disabled]="busy"><div class="row g-4">
<div class="col-lg-6"><section class="card p-3 h-100"><h3 class="h5">1. Agent groups</h3>
@for (group of data.agentGroups; track group.id) { <div class="d-flex gap-2 align-items-center mb-2"><button class="btn btn-link text-start flex-grow-1" (click)="editGroup(group)">{{group.name}} ({{group.agentIds.length}})</button><button class="btn btn-sm btn-outline-danger" (click)="save({action:'deleteAgentGroup',id:group.id})" [attr.aria-label]="'Delete ' + group.name">Delete</button></div> }
<label for="group-name">Group name</label><input id="group-name" class="form-control mb-2" [(ngModel)]="groupName" maxlength="150">
@for (agent of data.agents; track agent.id) { <label class="d-block mb-2"><input type="checkbox" class="form-check-input me-2" [checked]="members.includes(agent.id)" (change)="toggle(agent.id)">{{agent.name}}</label> }
<h4 class="h6 mt-3">Attach access roles</h4>
@for (role of data.roleGroups; track role.id) { <label class="d-block mb-2"><input type="checkbox" class="form-check-input me-2" [checked]="groupRoles.includes(role.id)" (change)="toggleRole(role.id)">{{role.name}}</label> } @empty { <p class="small text-muted">Create a role group, then attach it here.</p> }
@if (groupRoles.length) { <table class="table table-sm"><thead><tr><th>Granted API</th><th>Method</th><th>Access</th></tr></thead><tbody>@for (row of groupOperations; track row.key) { <tr><td>{{row.name}}<small class="d-block text-muted">{{row.path}}</small></td><td>{{row.method}}</td><td>{{row.access === 'R' ? 'Read' : 'Write'}}</td></tr> }</tbody></table> }
<div class="mt-2"><button class="btn btn-dark me-2" [disabled]="!groupName.trim()" (click)="save({action:'agentGroup',id:groupId,name:groupName,agentIds:members,roleGroupIds:groupRoles})">Save agent group</button><button class="btn btn-link" (click)="resetGroup()">New group</button></div></section></div>
<div class="col-lg-6"><section class="card p-3 h-100"><h3 class="h5">2. Role groups</h3>
@for (role of data.roleGroups; track role.id) { <div class="d-flex gap-2 align-items-center mb-2"><button class="btn btn-link text-start flex-grow-1" (click)="editRole(role)">{{role.name}}</button><button class="btn btn-sm btn-outline-danger" (click)="save({action:'deleteRoleGroup',id:role.id})" [attr.aria-label]="'Delete ' + role.name">Delete</button></div> }
<label for="role-name">Role name</label><input id="role-name" class="form-control mb-2" [(ngModel)]="roleName" maxlength="150">
<table class="table"><thead><tr><th>Service API</th><th>Method / access</th><th>Allow</th></tr></thead><tbody>
@for (permission of permissions; track permission.service) { @for (operation of operations(permission.service); track operation.method + operation.path) {
<tr><td>{{serviceName(permission.service)}}<small class="d-block text-muted">{{operation.path}}</small></td><td><span class="badge text-bg-light">{{operation.method}}</span> {{operation.access === 'R' ? 'Read' : 'Write'}}@if (operation.description) { <small class="d-block text-muted">{{operation.description}}</small> }</td><td><input type="checkbox" [ngModel]="operation.access === 'R' ? permission.read : permission.write" (ngModelChange)="setPermission(permission,operation,$event)" [attr.aria-label]="(operation.access === 'R' ? 'Read ' : 'Write ') + permission.service"></td></tr>
} }
</tbody></table><p class="small text-muted">Payroll investigation needs Read on payrun, payroll history, and employee details. Write grants do not create new agent capabilities.</p>
<div><button class="btn btn-dark me-2" [disabled]="!roleName.trim()" (click)="save({action:'roleGroup',id:roleId,name:roleName,permissions:permissions})">Save role group</button><button class="btn btn-link" (click)="resetRole()">New role</button></div></section></div>
<div class="col-12"><section class="card p-3"><h3 class="h5">3. Authorization mappings</h3>
<div class="d-flex flex-wrap gap-2 mb-3"><select class="form-select w-auto" aria-label="Agent group" [(ngModel)]="selectedGroup"><option value="">Choose agent group</option>@for (g of data.agentGroups; track g.id) { <option [value]="g.id">{{g.name}}</option> }</select><select class="form-select w-auto" aria-label="Role group" [(ngModel)]="selectedRole"><option value="">Choose role group</option>@for (r of data.roleGroups; track r.id) { <option [value]="r.id">{{r.name}}</option> }</select><button class="btn btn-dark" [disabled]="!selectedGroup || !selectedRole" (click)="save({action:'authorize',agentGroupId:selectedGroup,roleGroupId:selectedRole})">Grant access</button></div>
@for (mapping of data.authorizations; track mapping.id) { <div class="d-flex justify-content-between align-items-center border-top py-2"><span>{{groupLabel(mapping.agentGroupId)}} &rarr; {{roleLabel(mapping.roleGroupId)}}</span><button class="btn btn-outline-danger btn-sm" (click)="save({action:'revoke',id:mapping.id})">Revoke</button></div> } @empty { <p>No access granted.</p> }
</section></div></div></fieldset> }
</section>`})
export class AccessControlComponent implements OnChanges {
 @Input({required:true}) domain!: Domain;
 state: State | null = null; busy = false; error = ''; notice = ''; private request = 0;
 groupRoles: string[] = [];
 groupId = ''; groupName = ''; members: string[] = []; roleId = ''; roleName = ''; permissions: Permission[] = []; selectedGroup = ''; selectedRole = '';
 constructor(private api: ApiService) {}
 ngOnChanges(): void { this.state = null; this.resetGroup(); this.roleId = ''; this.roleName = ''; this.selectedGroup = ''; this.selectedRole = ''; void this.load(); }
 async load(): Promise<void> { const request = ++this.request; this.busy = true; this.error = ''; try { const result = await this.api.graphql<{agentAccess:State}>('query($domainName:String!){agentAccess(domainName:$domainName)}',{domainName:this.domain.name}); if(request === this.request){this.state=result.agentAccess;this.resetRole();} } catch(e){if(request === this.request)this.error=errorMessage(e);} finally {if(request === this.request)this.busy=false;} }
 async save(input: object): Promise<void> { const request = ++this.request; this.busy=true; this.error=''; this.notice=''; try {const result=await this.api.graphql<{manageAgentAccess:State}>('mutation($input:JSON!){manageAgentAccess(input:$input)}',{input:{...input,domainName:this.domain.name}});if(request===this.request){this.state=result.manageAgentAccess;this.notice='Access settings saved. Changes apply to the next agent action.';this.resetGroup();this.resetRole();this.selectedGroup='';this.selectedRole='';}}catch(e){if(request===this.request)this.error=errorMessage(e);}finally{if(request===this.request)this.busy=false;} }
 toggle(id:string):void {this.members=this.members.includes(id)?this.members.filter(x=>x!==id):[...this.members,id];}
 editGroup(g:Group):void {this.groupId=g.id;this.groupName=g.name;this.members=[...g.agentIds];this.groupRoles=(this.state?.authorizations||[]).filter(m=>m.agentGroupId===g.id).map(m=>m.roleGroupId);}
 resetGroup():void {this.groupId='';this.groupName='';this.members=[];this.groupRoles=[];}
 resetRole():void {this.roleId='';this.roleName='';this.permissions=(this.state?.services||[]).map(s=>({service:s.id,read:false,write:false}));}
 editRole(r:Role):void {this.resetRole();this.roleId=r.id;this.roleName=r.name;this.permissions=this.permissions.map(p=>({...p,...r.permissions.find(x=>x.service===p.service)}));}
 serviceName(id:string):string{return this.state?.services.find(x=>x.id===id)?.name||id;}
 groupLabel(id:string):string{return this.state?.agentGroups.find(x=>x.id===id)?.name||id;}
 roleLabel(id:string):string{return this.state?.roleGroups.find(x=>x.id===id)?.name||id;}
 toggleRole(id:string):void {this.groupRoles=this.groupRoles.includes(id)?this.groupRoles.filter(x=>x!==id):[...this.groupRoles,id];}
 operations(id:string):ApiOperation[] {return this.state?.services.find(s=>s.id===id)?.operations||[];}
 setPermission(permission:Permission,operation:ApiOperation,value:boolean):void {if(operation.access==='R')permission.read=value;else permission.write=value;}
 get groupOperations() {return (this.state?.services||[]).flatMap(s=>s.operations.filter(op=>this.state!.roleGroups.some(r=>this.groupRoles.includes(r.id)&&r.permissions.some(p=>p.service===s.id&&(op.access==='R'?p.read:p.write)))).map(op=>({...op,name:s.name,key:s.id+op.method+op.path})));}

}
