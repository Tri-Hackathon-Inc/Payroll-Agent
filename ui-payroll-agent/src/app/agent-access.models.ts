export interface ApiOperation { method: string; path: string; access: 'R' | 'W'; description?: string; }
export interface AccessService { id: string; name: string; operations: ApiOperation[]; }
export interface AccessPermission { service: string; read: boolean; write: boolean; }
export interface AccessGroup { id: string; name: string; agentIds: string[]; }
export interface AccessRole { id: string; name: string; permissions: AccessPermission[]; }
export interface AccessState {
 roleAssignments?: {agentId:string;roleGroupId:string}[];
 apiPermissions: (AccessPermission & {agentId:string})[]; contextPermissions: {readerId:string;sourceId:string}[];
 agents: {id: string; name: string; templateId?:string}[]; services: AccessService[]; agentGroups: AccessGroup[];
 roleGroups: AccessRole[]; authorizations: {id: string; agentGroupId: string; roleGroupId: string}[];
}
export function groupAllows(state: AccessState, groupId: string, service: string, access: 'R' | 'W'): boolean {
 const roles = state.authorizations.filter(m => m.agentGroupId === groupId).map(m => m.roleGroupId);
 return state.roleGroups.some(r => roles.includes(r.id) && r.permissions.some(p => p.service === service && (access === 'R' ? p.read : p.write)));
}
