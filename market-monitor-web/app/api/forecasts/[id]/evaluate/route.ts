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
    const { service } = await evaluationRequestContext(request, 'forecast_evaluate');
    const id = await routeForecastId(context);
    const body = await requestJson(request, { optional: true, maxBytes: 1_024 });
    return forecastJson(await service.evaluate(id, body));
  } catch (error) {
    return forecastErrorResponse(error, 'evaluate');
  }
}
