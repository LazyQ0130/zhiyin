import {NextRequest} from 'next/server';
import {endpoint} from '@/server/security/http';
import {api} from '@/server/services/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
async function handle(req:NextRequest,context:Context){const {path}=await context.params;return endpoint(req,id=>api(req,path,id));}
export {handle as GET,handle as POST,handle as PATCH,handle as DELETE};
