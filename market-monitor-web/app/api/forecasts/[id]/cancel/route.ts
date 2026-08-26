import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson, routeForecastId } from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Context) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_cancel');
    const id = await routeForecastId(context);
    const body = await requestJson(request);
    return forecastJson({ forecast: await service.cancel(id, body) });
  } catch (error) {
    return forecastErrorResponse(error, 'cancel');
  }
}
