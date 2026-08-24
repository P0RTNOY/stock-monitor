import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson, routeForecastId } from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: Request, context: Context) {
  try {
    const id = await routeForecastId(context);
    const { profileId, service } = await forecastRequestContext(request);
    return forecastJson({ forecast: await service.get(profileId, id) });
  } catch (error) {
    return forecastErrorResponse(error, 'read');
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const id = await routeForecastId(context);
    const body = await requestJson(request);
    const { profileId, service } = await forecastRequestContext(request);
    return forecastJson({ forecast: await service.updateDraft(profileId, id, body) });
  } catch (error) {
    return forecastErrorResponse(error, 'update');
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const id = await routeForecastId(context);
    const { profileId, service } = await forecastRequestContext(request);
    await service.deleteDraft(profileId, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return forecastErrorResponse(error, 'delete');
  }
}
