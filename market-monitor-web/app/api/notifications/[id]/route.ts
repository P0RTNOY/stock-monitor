import { handleGet, inAppErrorResponse } from '@/app/lib/server/in-app-notifications/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: Request, context: Context) {
  try { return await handleGet(request, (await context.params).id); }
  catch (error) { return inAppErrorResponse(error, 'detail'); }
}
