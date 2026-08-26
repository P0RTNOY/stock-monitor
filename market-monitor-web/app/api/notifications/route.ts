import { handleList, inAppErrorResponse } from '@/app/lib/server/in-app-notifications/http';

export async function GET(request: Request) {
  try { return await handleList(request); }
  catch (error) { return inAppErrorResponse(error, 'list'); }
}
