import { HomeAssistant } from 'custom-card-helpers';
import { HassHistory } from './types';

interface BatchRequest {
  entityId: string;
  start: Date | undefined;
  end: Date | undefined;
  skipInitialState: boolean;
  resolve: (value: HassHistory | undefined) => void;
  reject: (reason?: unknown) => void;
}

/**
 * HistoryFetcher manages batch fetching of history data for multiple entities.
 * It debounces requests within a time window and combines them into a single API call.
 */
class HistoryFetcher {
  private pendingRequests: Map<string, BatchRequest[]> = new Map();
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY_MS = 50; // Debounce window

  /**
   * Fetch history for a single entity, batching with other concurrent requests
   */
  public async fetchForEntity(
    entityId: string,
    start: Date | undefined,
    end: Date | undefined,
    skipInitialState: boolean,
    hass: HomeAssistant | undefined,
  ): Promise<HassHistory | undefined> {
    if (!hass) return undefined;

    return new Promise<HassHistory | undefined>((resolve, reject) => {
      const batchKey = this._getBatchKey(start, end, skipInitialState);

      // Add request to pending queue
      if (!this.pendingRequests.has(batchKey)) {
        this.pendingRequests.set(batchKey, []);
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.pendingRequests.get(batchKey)!.push({
        entityId,
        start,
        end,
        skipInitialState,
        resolve,
        reject,
      });

      // Schedule batch execution if not already scheduled
      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this._executeBatch(hass);
        }, this.BATCH_DELAY_MS);
      }
    });
  }

  /**
   * Generate a unique key for batching requests with same parameters
   */
  private _getBatchKey(
    start: Date | undefined,
    end: Date | undefined,
    skipInitialState: boolean,
  ): string {
    return `${start?.toISOString() || 'none'}_${end?.toISOString() || 'none'}_${skipInitialState}`;
  }

  /**
   * Execute all pending batched requests
   */
  private async _executeBatch(hass: HomeAssistant): Promise<void> {
    this.batchTimeout = null;

    // Process each batch key separately
    const batches = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();

    for (const [, requests] of batches) {
      if (requests.length === 0) continue;

      // If only one request, fetch individually
      if (requests.length === 1) {
        const req = requests[0];
        try {
          const result = await this._fetchSingle(req, hass);
          req.resolve(result);
        } catch (error) {
          req.reject(error);
        }
        continue;
      }

      // Batch multiple requests
      try {
        const entityIds = requests.map(r => r.entityId);
        const { start, end, skipInitialState } = requests[0];

        const batchedResult = await this._fetchBatched(
          entityIds,
          start,
          end,
          skipInitialState,
          hass,
        );

        // Distribute results to individual requests
        requests.forEach((req, index) => {
          if (batchedResult && batchedResult[index]) {
            req.resolve([batchedResult[index]]);
          } else {
            req.resolve(undefined);
          }
        });
      } catch (error) {
        // If batch fails, reject all requests
        requests.forEach(req => req.reject(error));
      }
    }
  }

  /**
   * Fetch history for a single entity
   */
  private async _fetchSingle(
    request: BatchRequest,
    hass: HomeAssistant,
  ): Promise<HassHistory | undefined> {
    const { entityId, start, end, skipInitialState } = request;
    let url = 'history/period';
    if (start) url += `/${start.toISOString()}`;
    url += `?filter_entity_id=${entityId}`;
    if (end) url += `&end_time=${end.toISOString()}`;
    if (skipInitialState) url += '&skip_initial_state';
    url += '&significant_changes_only=0';

    return hass.callApi('GET', url);
  }

  /**
   * Fetch history for multiple entities in a single request
   */
  private async _fetchBatched(
    entityIds: string[],
    start: Date | undefined,
    end: Date | undefined,
    skipInitialState: boolean,
    hass: HomeAssistant,
  ): Promise<HassHistory | undefined> {
    let url = 'history/period';
    if (start) url += `/${start.toISOString()}`;
    // Combine entity IDs with commas
    url += `?filter_entity_id=${entityIds.join(',')}`;
    if (end) url += `&end_time=${end.toISOString()}`;
    if (skipInitialState) url += '&skip_initial_state';
    url += '&significant_changes_only=0';

    return hass.callApi('GET', url);
  }
}

// Export a singleton instance
export const historyFetcher = new HistoryFetcher();
