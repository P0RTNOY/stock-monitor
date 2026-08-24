import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson, routeForecastId } from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Context) {
  try {
    const id = await routeForecastId(context);
    const body = await requestJson(request);
    const { profileId, service } = await forecastRequestContext(request);
    return forecastJson({ forecast: await service.addNote(profileId, id, body) }, { status: 201 });
  } catch (error) {
    return forecastErrorResponse(error, 'note');
  }
}
