import { handleState, inAppErrorResponse } from '@/app/lib/server/in-app-notifications/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Context) {
  try { return await handleState(request, (await context.params).id, 'unread'); }
  catch (error) { return inAppErrorResponse(error, 'mark unread'); }
}
