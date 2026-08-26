import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson } from '@/app/lib/server/forecasts/http';
import { normalizeFilters } from '@/app/lib/server/forecasts/validation';

export async function GET(request: Request) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_list');
    const forecasts = await service.list(normalizeFilters(new URL(request.url)));
    return forecastJson({ forecasts });
  } catch (error) {
    return forecastErrorResponse(error, 'list');
  }
}

export async function POST(request: Request) {
  try {
    const { service } = await forecastRequestContext(request, 'forecast_create');
    const body = await requestJson(request);
    const forecast = await service.createDraft(body);
    return forecastJson({ forecast }, { status: 201 });
  } catch (error) {
    return forecastErrorResponse(error, 'create');
  }
}
