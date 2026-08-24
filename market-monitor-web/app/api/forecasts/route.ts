import { forecastErrorResponse, forecastJson, forecastRequestContext, requestJson } from '@/app/lib/server/forecasts/http';
import { normalizeFilters } from '@/app/lib/server/forecasts/validation';

export async function GET(request: Request) {
  try {
    const { profileId, service } = await forecastRequestContext(request);
    const forecasts = await service.list(profileId, normalizeFilters(new URL(request.url)));
    return forecastJson({ forecasts });
  } catch (error) {
    return forecastErrorResponse(error, 'list');
  }
}

export async function POST(request: Request) {
  try {
    const body = await requestJson(request);
    const { profileId, service } = await forecastRequestContext(request);
    const forecast = await service.createDraft(profileId, body);
    return forecastJson({ forecast }, { status: 201 });
  } catch (error) {
    return forecastErrorResponse(error, 'create');
  }
}
