import {
  verificationConfirmationGet,
  verificationConfirmationPost,
} from '@/app/lib/server/email/public-actions';
import { emailPublicActionService } from '@/app/lib/server/email/public-runtime';

export function GET(request: Request) {
  return verificationConfirmationGet(request);
}

export function POST(request: Request) {
  return verificationConfirmationPost(request, () => emailPublicActionService(request));
}
