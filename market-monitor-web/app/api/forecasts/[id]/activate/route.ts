import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson, routeForecastId } from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Context) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_activate');
    const id = await routeForecastId(context);
    const body = await requestJson(request, { optional: true });
    return forecastJson({ forecast: await service.activate(id, body) });
  } catch (error) {
    return forecastErrorResponse(error, 'activate');
  }
}
