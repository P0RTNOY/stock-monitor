import {
  evaluationRequestContext,
  forecastErrorResponse,
  forecastJson,
  requestJson,
  routeForecastId,
} from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Context) {
  try {
    const { service } = await evaluationRequestContext(request, 'review_acknowledge');
    const id = await routeForecastId(context);
    const body = await requestJson(request, { maxBytes: 1_024 });
    return forecastJson({ reviewItem: await service.acknowledgeReview(id, body) });
  } catch (error) {
    return forecastErrorResponse(error, 'acknowledge evaluation review');
  }
}
