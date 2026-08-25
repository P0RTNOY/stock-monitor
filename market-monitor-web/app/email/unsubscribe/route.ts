import {
  unsubscribeConfirmationGet,
  unsubscribeConfirmationPost,
} from '@/app/lib/server/email/public-actions';
import { emailPublicActionService } from '@/app/lib/server/email/public-runtime';

export function GET(request: Request) {
  return unsubscribeConfirmationGet(request);
}

export function POST(request: Request) {
  return unsubscribeConfirmationPost(request, () => emailPublicActionService(request));
}
