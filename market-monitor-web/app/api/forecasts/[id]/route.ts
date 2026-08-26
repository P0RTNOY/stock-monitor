import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson, routeForecastId } from '@/app/lib/server/forecasts/http';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: Request, context: Context) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_read');
    const id = await routeForecastId(context);
    return forecastJson({ forecast: await service.get(id) });
  } catch (error) {
    return forecastErrorResponse(error, 'read');
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_edit');
    const id = await routeForecastId(context);
    const body = await requestJson(request);
    return forecastJson({ forecast: await service.updateDraft(id, body) });
  } catch (error) {
    return forecastErrorResponse(error, 'update');
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_delete');
    const id = await routeForecastId(context);
    await service.deleteDraft(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return forecastErrorResponse(error, 'delete');
  }
}
