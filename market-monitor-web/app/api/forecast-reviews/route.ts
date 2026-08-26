import { evaluationRequestContext, forecastErrorResponse, forecastJson } from '@/app/lib/server/forecasts/http';
import { ForecastServiceError } from '@/app/lib/server/forecasts/service';

export async function GET(request: Request) {
  try {
    const { service } = await evaluationRequestContext(request, 'review_list');
    const url = new URL(request.url);
    const unknown = [...url.searchParams.keys()].filter((key) => key !== 'includeAcknowledged');
    if (unknown.length) throw new ForecastServiceError('Unsupported review filter.', 'validation_error', 400);
    const raw = url.searchParams.get('includeAcknowledged');
    if (raw !== null && raw !== 'true' && raw !== 'false') {
      throw new ForecastServiceError('includeAcknowledged must be true or false.', 'validation_error', 400);
    }
    return forecastJson({ reviewItems: await service.listReviews(raw === 'true') });
  } catch (error) {
    return forecastErrorResponse(error, 'list evaluation reviews');
  }
}
