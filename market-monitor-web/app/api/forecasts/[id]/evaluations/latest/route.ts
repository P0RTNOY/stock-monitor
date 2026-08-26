import { evaluationRequestContext, forecastErrorResponse, forecastJson, routeForecastId } from '@/app/lib/server/forecasts/http';
import { ForecastServiceError } from '@/app/lib/server/forecasts/service';

type Context = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: Request, context: Context) {
  try {
    const { service } = await evaluationRequestContext(request, 'evaluation_read');
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length) {
      throw new ForecastServiceError('Evaluation history does not support query parameters.', 'validation_error', 400);
    }
    const id = await routeForecastId(context);
    return forecastJson({ evaluationRun: await service.latestEvaluation(id) });
  } catch (error) {
    return forecastErrorResponse(error, 'load latest evaluation');
  }
}
