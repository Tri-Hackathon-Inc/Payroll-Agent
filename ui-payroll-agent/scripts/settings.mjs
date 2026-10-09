import { config } from 'dotenv';
config({ path: '.env', quiet: true });
config({ path: '.env.local', override: true, quiet: true });
export const basePath = value => {
  const part = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return part ? `/${part}/` : '/';
};
export const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/');
