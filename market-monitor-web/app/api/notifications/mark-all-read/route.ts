import { handleMarkAll, inAppErrorResponse } from '@/app/lib/server/in-app-notifications/http';

export async function POST(request: Request) {
  try { return await handleMarkAll(request); }
  catch (error) { return inAppErrorResponse(error, 'mark all read'); }
}
