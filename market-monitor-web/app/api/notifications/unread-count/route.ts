import { handleCount, inAppErrorResponse } from '@/app/lib/server/in-app-notifications/http';

export async function GET(request: Request) {
  try { return await handleCount(request); }
  catch (error) { return inAppErrorResponse(error, 'count'); }
}
