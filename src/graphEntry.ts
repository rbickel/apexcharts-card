import { HomeAssistant } from 'custom-card-helpers';
import {
  ChartCardSeriesConfig,
  EntityCachePoints,
  EntityEntryCache,
  EntityAggregatedCache,
  HassHistory,
  HassHistoryEntry,
  HistoryBuckets,
  HistoryPoint,
  Statistics,
  StatisticValue,
} from './types';
import { compress, decompress, log } from './utils';
import localForage from 'localforage';
import { HassEntity } from 'home-assistant-js-websocket';
import { DateRange } from 'moment-range';
import { DEFAULT_STATISTICS_PERIOD, DEFAULT_STATISTICS_TYPE, moment } from './const';
import parse from 'parse-duration';
import SparkMD5 from 'spark-md5';
import { ChartCardSpanExtConfig, StatisticsPeriod } from './types-config';
import * as pjson from '../package.json';
import { historyFetcher } from './historyFetcher';

export default class GraphEntry {
  private _computedHistory?: EntityCachePoints;

  private _hass?: HomeAssistant;

  private _entityID: string;

  private _entityState?: HassEntity;

  private _updating = false;

  private _cache: boolean;

  // private _hoursToShow: number;

  private _graphSpan: number;

  private _useCompress = false;

  private _index: number;

  private _config: ChartCardSeriesConfig;

  private _func: (item: EntityCachePoints) => number | null | [number, number];

  private _realStart: Date;

  private _realEnd: Date;

  private _groupByDurationMs: number;

  private _md5Config: string;

  public headerOnlyMode = false;

  constructor(
    index: number,
    graphSpan: number,
    cache: boolean,
    config: ChartCardSeriesConfig,
    span: ChartCardSpanExtConfig | undefined,
  ) {
    const aggregateFuncMap = {
      avg: this._average,
      max: this._maximum,
      min: this._minimum,
      first: this._first,
      last: this._last,
      sum: this._sum,
      median: this._median,
      delta: this._delta,
      diff: this._diff,
      minmax: this._minmax,
    };
    this._index = index;
    this._cache = config.statistics ? false : cache;
    this._entityID = config.entity;
    this._graphSpan = graphSpan;
    this._config = config;
    this._func = aggregateFuncMap[config.group_by.func];
    this._realEnd = new Date();
    this._realStart = new Date();
    // Valid because tested during init;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this._groupByDurationMs = parse(this._config.group_by.duration)!;
    this._md5Config = SparkMD5.hash(`${this._graphSpan}${JSON.stringify(this._config)}${JSON.stringify(span)}`);
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._entityState = this._hass.states[this._entityID];
  }

  get history(): EntityCachePoints {
    return this._computedHistory || [];
  }

  get index(): number {
    return this._index;
  }

  get start(): Date {
    return this._realStart;
  }

  get end(): Date {
    return this._realEnd;
  }

  set cache(cache: boolean) {
    this._cache = this._config.statistics ? false : cache;
  }

  get lastState(): number | [number, number] | null {
    return this.history.length > 0 ? this.history[this.history.length - 1][1] : null;
  }

  public nowValue(now: number, before: boolean): number | [number, number] | null {
    if (this.history.length === 0) return null;
    const index = this.history.findIndex((point, index, arr) => {
      if (!before && point[0] > now) return true;
      if (before && point[0] < now && arr[index + 1] && arr[index + 1][0] > now) return true;
      return false;
    });
    if (index === -1) return null;
    return this.history[index][1];
  }

  get min(): number | undefined {
    if (!this._computedHistory || this._computedHistory.length === 0) return undefined;
    return Math.min(...this._computedHistory.flatMap((item) => {
      if (item[1] === null) return [];
      if (Array.isArray(item[1])) return [item[1][0]]; // Min of range
      return [item[1]];
    }));
  }

  get max(): number | undefined {
    if (!this._computedHistory || this._computedHistory.length === 0) return undefined;
    return Math.max(...this._computedHistory.flatMap((item) => {
      if (item[1] === null) return [];
      if (Array.isArray(item[1])) return [item[1][1]]; // Max of range
      return [item[1]];
    }));
  }

  public minMaxWithTimestamp(
    start: number,
    end: number,
    offset: number,
  ): { min: HistoryPoint; max: HistoryPoint } | undefined {
    if (!this._computedHistory || this._computedHistory.length === 0) return undefined;
    if (this._computedHistory.length === 1)
      return { min: [start, this._computedHistory[0][1]] as HistoryPoint, max: [end, this._computedHistory[0][1]] as HistoryPoint };
    const minMax = this._computedHistory.reduce(
      (acc: { min: HistoryPoint; max: HistoryPoint }, point) => {
        if (point[1] === null) return acc;
        if (point[0] > end || point[0] < start) return acc;
        if (acc.max[1] === null || acc.max[1] < point[1]) acc.max = [...point];
        if (acc.min[1] === null || (point[1] !== null && acc.min[1] > point[1])) acc.min = [...point];
        return acc;
      },
      { min: [0, null], max: [0, null] },
    );
    if (offset) {
      if (minMax.min[0]) minMax.min[0] -= offset;
      if (minMax.max[0]) minMax.max[0] -= offset;
    }
    return minMax;
  }

  public minMaxWithTimestampForYAxis(start: number, end: number): { min: HistoryPoint; max: HistoryPoint } | undefined {
    if (!this._computedHistory || this._computedHistory.length === 0) return undefined;
    let lastTimestampBeforeStart = start;
    const lastHistoryIndexBeforeStart =
      this._computedHistory.findIndex((hist) => {
        return hist[0] >= start;
      }) - 1;
    if (lastHistoryIndexBeforeStart >= 0)
      lastTimestampBeforeStart = this._computedHistory[lastHistoryIndexBeforeStart][0];
    return this.minMaxWithTimestamp(lastTimestampBeforeStart, end, 0);
  }

  private async _getCache(key: string, compressed: boolean): Promise<EntityEntryCache | undefined> {
    const data: EntityEntryCache | undefined | null = await localForage.getItem(
      `${key}_${this._md5Config}${compressed ? '' : '-raw'}`,
    );
    return data ? (compressed ? decompress(data) : data) : undefined;
  }

  private async _setCache(
    key: string,
    data: EntityEntryCache,
    compressed: boolean,
  ): Promise<string | EntityEntryCache> {
    return compressed
      ? localForage.setItem(`${key}_${this._md5Config}`, compress(data))
      : localForage.setItem(`${key}_${this._md5Config}-raw`, data);
  }

  private async _getAggregatedCache(key: string): Promise<EntityAggregatedCache | undefined> {
    const data: EntityAggregatedCache | undefined | null = await localForage.getItem(
      `${key}_${this._md5Config}_agg`,
    );
    if (!data) return undefined;

    // Validate aggregation config matches
    if (data.aggregation_config.duration_ms !== this._groupByDurationMs ||
        data.aggregation_config.func !== this._config.group_by.func ||
        data.aggregation_config.fill !== this._config.group_by.fill ||
        data.aggregation_config.start_with_last !== (this._config.group_by.start_with_last || false)) {
      return undefined;
    }

    return data;
  }

  private async _setAggregatedCache(key: string, data: EntityAggregatedCache): Promise<void> {
    await localForage.setItem(`${key}_${this._md5Config}_agg`, data);
  }

  public async _updateHistory(start: Date, end: Date): Promise<boolean> {
    let startHistory = new Date(start);
    if (this._config.group_by.func !== 'raw') {
      const range = end.getTime() - start.getTime();
      const nbBuckets = Math.floor(range / this._groupByDurationMs) + (range % this._groupByDurationMs > 0 ? 1 : 0);
      startHistory = new Date(end.getTime() - (nbBuckets + 1) * this._groupByDurationMs);
    }
    if (!this._entityState || this._updating) return false;
    this._updating = true;

    // Fast path for header-only series
    if (this.headerOnlyMode && this._config.group_by.func !== 'raw') {
      return this._updateHeaderOnly();
    }

    if (this._config.ignore_history) {
      let currentState: null | number | string = null;
      if (this._config.attribute) {
        currentState = this._entityState.attributes?.[this._config.attribute];
      } else {
        currentState = this._entityState.state;
      }
      if (this._config.transform) {
        currentState = this._applyTransform(currentState, this._entityState);
      }
      let stateParsed: number | null = parseFloat(currentState as string);
      stateParsed = !Number.isNaN(stateParsed) ? stateParsed : null;
      this._computedHistory = [[new Date(this._entityState.last_updated).getTime(), stateParsed]];
      this._updating = false;
      return true;
    }

    let history: EntityEntryCache | undefined = undefined;

    if (this._config.data_generator) {
      history = await this._generateData(start, end);
    } else {
      this._realStart = new Date(start);
      this._realEnd = new Date(end);

      let skipInitialState = false;

      history = this._cache ? await this._getCache(this._entityID, this._useCompress) : undefined;

      if (history && history.span === this._graphSpan) {
        const currDataIndex = history.data.findIndex(
          (item) => item && new Date(item[0]).getTime() > startHistory.getTime(),
        );
        if (currDataIndex !== -1) {
          // skip initial state when fetching recent/not-cached data
          skipInitialState = true;
        }
        if (currDataIndex > 4) {
          // >4 so that the graph has some more history
          history.data = history.data.slice(currDataIndex === 0 ? 0 : currDataIndex - 4);
        } else if (currDataIndex === -1) {
          // there was no state which could be used in current graph so clearing
          history.data = [];
        }
      } else {
        history = undefined;
      }
      const usableCache = !!(
        history &&
        history.data &&
        history.data.length !== 0 &&
        history.data[history.data.length - 1]
      );

      // if data in cache, get data from last data's time + 1ms
      const fetchStart = usableCache
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          new Date(history!.data[history!.data.length - 1][0] + 1)
        : new Date(startHistory.getTime() + (this._config.group_by.func !== 'raw' ? 0 : -1));
      const fetchEnd = end;

      let newStateHistory: EntityCachePoints = [];
      let updateGraphHistory = false;

      if (this._config.statistics) {
        const newHistory = await this._fetchStatistics(fetchStart, fetchEnd, this._config.statistics.period);
        if (newHistory && newHistory.length > 0) {
          updateGraphHistory = true;
          let lastNonNull: number | null | [number, number] = null;
          if (history && history.data && history.data.length > 0) {
            lastNonNull = history.data[history.data.length - 1][1];
          }
          newStateHistory = newHistory.map((item) => {
            let stateParsed: number | null | [number, number] = null;

            // For rangeArea series, extract both min and max from statistics
            if (this._config.type === 'rangeArea' && item.min !== null && item.max !== null) {
              stateParsed = [item.min, item.max];
              // For fill_raw handling with range values
              if (this._config.fill_raw === 'last' && Array.isArray(lastNonNull)) {
                // Keep lastNonNull as is for range values
              } else if (this._config.fill_raw === 'zero') {
                if (stateParsed === null) stateParsed = [0, 0];
              }
              lastNonNull = stateParsed;
            } else {
              // Original single-value logic
              let singleValue: number | null = null;
              [lastNonNull as number | null, singleValue] = this._transformAndFill(
                item[this._config.statistics?.type || DEFAULT_STATISTICS_TYPE],
                item,
                Array.isArray(lastNonNull) ? null : lastNonNull,
              );
              stateParsed = singleValue;
            }

            let displayDate: Date | null = null;
            const startDate = new Date(item.start);
            if (!this._config.statistics?.align || this._config.statistics?.align === 'middle') {
              if (this._config.statistics?.period === '5minute') {
                displayDate = new Date(startDate.getTime() + 150000); // 2min30s
              } else if (!this._config.statistics?.period || this._config.statistics.period === 'hour') {
                displayDate = new Date(startDate.getTime() + 1800000); // 30min
              } else if (this._config.statistics.period === 'day') {
                displayDate = new Date(startDate.getTime() + 43200000); // 12h
              } else if (this._config.statistics.period === 'week') {
                displayDate = new Date(startDate.getTime() + 259200000); // 3.5d
              } else {
                displayDate = new Date(startDate.getTime() + 1296000000); // 15d
              }
            } else if (this._config.statistics.align === 'start') {
              displayDate = new Date(item.start);
            } else {
              displayDate = new Date(item.end);
            }

            return [displayDate.getTime(), stateParsed !== null && (typeof stateParsed === 'number' ? !Number.isNaN(stateParsed) : true) ? stateParsed : null] as HistoryPoint;
          });
        }
      } else {
        const newHistory = await this._fetchRecent(
          fetchStart,
          fetchEnd,
          this._config.attribute || this._config.transform ? false : skipInitialState,
        );
        if (newHistory && newHistory[0] && newHistory[0].length > 0) {
          updateGraphHistory = true;
          /*
          hack because HA doesn't return anything if skipInitialState is false
          when retrieving for attributes so we retrieve it and we remove it.
          */
          if ((this._config.attribute || this._config.transform) && skipInitialState) {
            newHistory[0].shift();
          }
          let lastNonNull: number | null | [number, number] = null;
          if (history && history.data && history.data.length > 0) {
            lastNonNull = history.data[history.data.length - 1][1];
          }
          newStateHistory = newHistory[0].map((item) => {
            let currentState: unknown = null;
            if (this._config.attribute) {
              if (item.attributes && item.attributes[this._config.attribute] !== undefined) {
                currentState = item.attributes[this._config.attribute];
              }
            } else {
              currentState = item.state;
            }
            let stateParsed: number | null = null;
            const scalarLastNonNull = Array.isArray(lastNonNull) ? null : lastNonNull;
            [lastNonNull, stateParsed] = this._transformAndFill(currentState, item, scalarLastNonNull) as [number | null, number | null];

            if (this._config.attribute) {
              return [new Date(item.last_updated).getTime(), !Number.isNaN(stateParsed) ? stateParsed : null];
            } else {
              return [new Date(item.last_changed).getTime(), !Number.isNaN(stateParsed) ? stateParsed : null];
            }
          });
        }
      }

      if (updateGraphHistory) {
        if (history?.data.length) {
          history.span = this._graphSpan;
          history.last_fetched = new Date();
          history.card_version = pjson.version;
          if (history.data.length !== 0) {
            history.data.push(...newStateHistory);
          }
        } else {
          history = {
            span: this._graphSpan,
            card_version: pjson.version,
            last_fetched: new Date(),
            data: newStateHistory,
          };
        }

        if (this._cache) {
          await this._setCache(this._entityID, history, this._useCompress).catch((err) => {
            log(err);
            localForage.clear();
          });
        }
      }
    }

    if (!history || history.data.length === 0) {
      this._updating = false;
      this._computedHistory = undefined;
      return false;
    }
    if (this._config.group_by.func !== 'raw') {
      // Try to use aggregated cache for better performance
      if (this._cache) {
        const aggCache = await this._getAggregatedCache(this._entityID);
        if (aggCache && aggCache.buckets.length > 0) {
          // Check if we can use cached buckets
          const lastBucketTime = aggCache.buckets[aggCache.buckets.length - 1].timestamp;
          const cacheEndTime = lastBucketTime + this._groupByDurationMs;

          // If cache covers our range, use it
          if (cacheEndTime >= end.getTime()) {
            // Filter buckets to our time range
            const filteredBuckets = aggCache.buckets.filter(
              bucket => bucket.timestamp >= startHistory.getTime() && bucket.timestamp < end.getTime()
            );
            const res: EntityCachePoints = filteredBuckets.map((bucket) => {
              return [bucket.timestamp, this._func(bucket.data)] as HistoryPoint;
            });
            if ([undefined, 'line', 'area', 'rangeArea'].includes(this._config.type)) {
              while (res.length > 0 && res[0][1] === null) res.shift();
            }
            this._computedHistory = res;
            this._updating = false;
            return true;
          }
        }
      }

      // Compute buckets from scratch
      const buckets = this._dataBucketer(history, moment.range(startHistory, end));
      const res: EntityCachePoints = buckets.map((bucket) => {
        return [bucket.timestamp, this._func(bucket.data)] as HistoryPoint;
      });

      // Save aggregated cache for future use
      if (this._cache && buckets.length > 0) {
        const aggCache: EntityAggregatedCache = {
          span: this._graphSpan,
          card_version: pjson.version,
          last_fetched: new Date(),
          data: history.data,
          aggregation_config: {
            duration_ms: this._groupByDurationMs,
            func: this._config.group_by.func,
            fill: this._config.group_by.fill,
            start_with_last: this._config.group_by.start_with_last || false,
          },
          buckets: buckets,
          raw_data_hash: SparkMD5.hash(JSON.stringify(history.data.slice(-100))),
        };
        await this._setAggregatedCache(this._entityID, aggCache).catch((err) => {
          log(err);
        });
      }

      if ([undefined, 'line', 'area', 'rangeArea'].includes(this._config.type)) {
        while (res.length > 0 && res[0][1] === null) res.shift();
      }
      this._computedHistory = res;
    } else {
      this._computedHistory = history.data;
    }
    this._updating = false;
    return true;
  }

  private _transformAndFill(
    currentState: unknown,
    item: HassHistoryEntry | StatisticValue,
    lastNonNull: number | null,
  ): [number | null, number | null] {
    if (this._config.transform) {
      currentState = this._applyTransform(currentState, item);
    }
    let stateParsed: number | null = parseFloat(currentState as string);
    stateParsed = !Number.isNaN(stateParsed) ? stateParsed : null;
    if (stateParsed === null) {
      if (this._config.fill_raw === 'zero') {
        stateParsed = 0;
      } else if (this._config.fill_raw === 'last') {
        stateParsed = lastNonNull;
      }
    } else {
      lastNonNull = stateParsed;
    }
    return [lastNonNull, stateParsed];
  }

  private _applyTransform(value: unknown, historyItem: HassHistoryEntry | StatisticValue): number | null {
    return new Function('x', 'hass', 'entity', `'use strict'; ${this._config.transform}`).call(
      this,
      value,
      this._hass,
      historyItem,
    );
  }

  private async _fetchRecent(
    start: Date | undefined,
    end: Date | undefined,
    skipInitialState: boolean,
  ): Promise<HassHistory | undefined> {
    // Use batch fetcher for better performance when multiple series fetch concurrently
    return historyFetcher.fetchForEntity(
      this._entityID,
      start,
      end,
      skipInitialState,
      this._hass
    );
  }

  private async _generateData(start: Date, end: Date): Promise<EntityEntryCache> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let data;
    try {
      const datafn = new AsyncFunction(
        'entity',
        'start',
        'end',
        'hass',
        'moment',
        `'use strict'; ${this._config.data_generator}`,
      );
      data = await datafn(this._entityState, start, end, this._hass, moment);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const funcTrimmed =
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._config.data_generator!.length <= 100
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._config.data_generator!.trim()
          : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            `${this._config.data_generator!.trim().substring(0, 98)}...`;
      e.message = `${e.name}: ${e.message} in '${funcTrimmed}'`;
      e.name = 'Error';
      throw e;
    }
    return {
      span: 0,
      card_version: pjson.version,
      last_fetched: new Date(),
      data,
    };
  }

  private async _fetchStatistics(
    start: Date | undefined,
    end: Date | undefined,
    period: StatisticsPeriod = DEFAULT_STATISTICS_PERIOD,
  ): Promise<StatisticValue[] | undefined> {
    const statistics = await this._hass?.callWS<Statistics>({
      type: 'recorder/statistics_during_period',
      start_time: start?.toISOString(),
      end_time: end?.toISOString(),
      statistic_ids: [this._entityID],
      period,
    });
    if (statistics && this._entityID in statistics) {
      return statistics[this._entityID];
    }
    return undefined;
  }

  private _dataBucketer(history: EntityEntryCache, timeRange: DateRange): HistoryBuckets {
    // Optimized bucketing using hash map approach for O(n) complexity instead of O(n*m)
    const bucketDuration = this._groupByDurationMs;
    const buckets: HistoryBuckets = [];
    const bucketMap = new Map<number, number>(); // timestamp -> bucket index

    // Step 1: Pre-allocate buckets (O(m))
    let currentTime = timeRange.start.valueOf();
    const endTime = timeRange.end.valueOf();
    let bucketIndex = 0;

    while (currentTime < endTime) {
      buckets.push({
        timestamp: currentTime,
        data: []
      });
      bucketMap.set(currentTime, bucketIndex);
      currentTime += bucketDuration;
      bucketIndex++;
    }

    // Step 2: Assign data points to buckets using hash map (O(n))
    history?.data.forEach((entry) => {
      // Calculate which bucket this entry belongs to
      const bucketTimestamp = Math.floor(entry[0] / bucketDuration) * bucketDuration;
      const index = bucketMap.get(bucketTimestamp);

      // Assign to the bucket (entries belong to the bucket they fall into)
      if (index !== undefined && index < buckets.length && index >= 0) {
        buckets[index].data.push(entry);
      }
    });

    // Step 3: Fill empty buckets and handle start_with_last (O(m))
    this._fillEmptyBuckets(buckets, history);

    // Step 4: Cleanup - remove first, last, and trailing null buckets
    buckets.shift();
    buckets.pop();
    this._removeTrailingNulls(buckets);

    return buckets;
  }

  private _fillEmptyBuckets(buckets: HistoryBuckets, history: EntityEntryCache): void {
    let lastNonNullBucketValue: number | [number, number] | null = null;
    const now = new Date().getTime();

    buckets.forEach((bucket, index) => {
      if (bucket.data.length === 0) {
        // Fill empty bucket based on configuration
        if (bucket.timestamp <= now || this._config.data_generator) {
          bucket.data[0] = this._createFillPoint(bucket.timestamp, lastNonNullBucketValue);
        }
      } else {
        lastNonNullBucketValue = bucket.data[bucket.data.length - 1][1];
      }

      // Handle start_with_last configuration
      if (this._config.group_by.start_with_last) {
        if (index > 0) {
          if (bucket.data.length === 0 || bucket.data[0][0] !== bucket.timestamp) {
            const prevBucketData = buckets[index - 1].data;
            if (prevBucketData.length > 0) {
              bucket.data.unshift([bucket.timestamp, prevBucketData[prevBucketData.length - 1][1]] as HistoryPoint);
            }
          }
        } else {
          // First bucket - find previous value from history
          const firstIndexAfter = history.data.findIndex((entry) => entry[0] > bucket.timestamp);
          if (firstIndexAfter > 0) {
            bucket.data.unshift([bucket.timestamp, history.data[firstIndexAfter - 1][1]] as HistoryPoint);
          }
        }
      }
    });
  }

  private _createFillPoint(timestamp: number, lastValue: number | [number, number] | null): HistoryPoint {
    const fill = this._config.group_by.fill;
    if (fill === 'last') {
      return [timestamp, lastValue] as HistoryPoint;
    } else if (fill === 'zero') {
      return [timestamp, 0];
    } else if (fill === 'null') {
      return [timestamp, null];
    }
    return [timestamp, null];
  }

  private _removeTrailingNulls(buckets: HistoryBuckets): void {
    while (
      buckets.length > 0 &&
      (buckets[buckets.length - 1].data.length === 0 ||
        (buckets[buckets.length - 1].data.length === 1 && buckets[buckets.length - 1].data[0][1] === null))
    ) {
      buckets.pop();
    }
  }

  private async _updateHeaderOnly(): Promise<boolean> {
    const func = this._config.group_by.func;

    // Use statistics API for aggregations when possible (and no transform)
    if (['min', 'max', 'avg', 'sum'].includes(func) && !this._config.transform) {
      return this._fetchHeaderFromStatistics();
    }

    // Otherwise, fetch minimal recent history
    return this._fetchHeaderFromRecentHistory();
  }

  private async _fetchHeaderFromStatistics(): Promise<boolean> {
    const func = this._config.group_by.func;
    const period = this._determineBestStatisticsPeriod();

    const stats = await this._fetchStatistics(
      new Date(Date.now() - 3600000), // Last hour
      new Date(),
      period
    );

    if (!stats || stats.length === 0) {
      this._computedHistory = [];
      this._updating = false;
      return false;
    }

    const latest = stats[stats.length - 1];
    let value: number | null = null;

    switch (func) {
      case 'min': value = latest.min; break;
      case 'max': value = latest.max; break;
      case 'avg': value = latest.mean; break;
      case 'sum': value = latest.sum; break;
      default: value = latest.state; break;
    }

    // Create minimal history for header display
    this._computedHistory = [[Date.now(), value]];
    this._updating = false;
    return true;
  }

  private async _fetchHeaderFromRecentHistory(): Promise<boolean> {
    // Fetch only recent hour instead of full graph_span
    const end = new Date();
    const start = new Date(end.getTime() - 3600000); // 1 hour

    const history = await this._fetchRecent(start, end, false);

    const historyData = history?.[0];
    if (!historyData) {
      this._computedHistory = [];
      this._updating = false;
      return false;
    }

    // Process data points
    let lastNonNull: number | null | [number, number] = null;
    const processed: EntityCachePoints = historyData.map((item) => {
      let currentState: unknown = null;
      if (this._config.attribute) {
        if (item.attributes && item.attributes[this._config.attribute] !== undefined) {
          currentState = item.attributes[this._config.attribute];
        }
      } else {
        currentState = item.state;
      }
      let stateParsed: number | null = null;
      const scalarLastNonNull = Array.isArray(lastNonNull) ? null : lastNonNull;
      [lastNonNull, stateParsed] = this._transformAndFill(currentState, item, scalarLastNonNull) as [number | null, number | null];

      if (this._config.attribute) {
        return [new Date(item.last_updated).getTime(), !Number.isNaN(stateParsed) ? stateParsed : null];
      } else {
        return [new Date(item.last_changed).getTime(), !Number.isNaN(stateParsed) ? stateParsed : null];
      }
    });

    // Apply aggregation function to get single value
    const value = this._func(processed);

    this._computedHistory = [[Date.now(), value] as HistoryPoint];
    this._updating = false;
    return true;
  }

  private _determineBestStatisticsPeriod(): StatisticsPeriod {
    // Choose statistics period based on group_by duration
    if (this._groupByDurationMs <= 300000) return '5minute';
    if (this._groupByDurationMs <= 3600000) return 'hour';
    if (this._groupByDurationMs <= 86400000) return 'day';
    if (this._groupByDurationMs <= 604800000) return 'week';
    return 'month';
  }

  private _sum(items: EntityCachePoints): number {
    if (items.length === 0) return 0;
    let lastIndex = 0;
    return items.reduce((sum, entry, index) => {
      let val = 0;
      if (entry && entry[1] === null) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const lastVal = items[lastIndex][1]!;
        val = Array.isArray(lastVal) ? (lastVal[0] + lastVal[1]) / 2 : lastVal;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const currentVal = entry[1]!;
        val = Array.isArray(currentVal) ? (currentVal[0] + currentVal[1]) / 2 : currentVal;
        lastIndex = index;
      }
      return sum + val;
    }, 0);
  }

  private _average(items: EntityCachePoints): number | null {
    const nonNull = this._filterNulls(items);
    if (nonNull.length === 0) return null;
    return this._sum(nonNull) / nonNull.length;
  }

  private _minimum(items: EntityCachePoints): number | null {
    let min: number | null = null;
    items.forEach((item) => {
      if (item[1] !== null) {
        const value = Array.isArray(item[1]) ? item[1][0] : item[1];
        if (min === null) min = value;
        else min = Math.min(value, min);
      }
    });
    return min;
  }

  private _maximum(items: EntityCachePoints): number | null {
    let max: number | null = null;
    items.forEach((item) => {
      if (item[1] !== null) {
        const value = Array.isArray(item[1]) ? item[1][1] : item[1];
        if (max === null) max = value;
        else max = Math.max(value, max);
      }
    });
    return max;
  }

  private _last(items: EntityCachePoints): number | null | [number, number] {
    if (items.length === 0) return null;
    const lastValue = items.slice(-1)[0][1];
    return lastValue;
  }

  private _first(items: EntityCachePoints): number | null | [number, number] {
    if (items.length === 0) return null;
    const firstValue = items[0][1];
    return firstValue;
  }

  private _median(items: EntityCachePoints) {
    const itemsDup = this._filterNulls([...items]).sort((a, b) => {
      const aVal = Array.isArray(a[1]) ? (a[1][0] + a[1][1]) / 2 : a[1]!;
      const bVal = Array.isArray(b[1]) ? (b[1][0] + b[1][1]) / 2 : b[1]!;
      return aVal - bVal;
    });
    if (itemsDup.length === 0) return null;
    if (itemsDup.length === 1) {
      const val = itemsDup[0][1];
      return Array.isArray(val) ? (val[0] + val[1]) / 2 : val;
    }
    const mid = Math.floor((itemsDup.length - 1) / 2);
    if (itemsDup.length % 2 === 1) {
      const val = itemsDup[mid][1];
      return Array.isArray(val) ? (val[0] + val[1]) / 2 : val;
    }
    const val1 = itemsDup[mid][1];
    const val2 = itemsDup[mid + 1][1];
    const num1 = Array.isArray(val1) ? (val1[0] + val1[1]) / 2 : val1!;
    const num2 = Array.isArray(val2) ? (val2[0] + val2[1]) / 2 : val2!;
    return (num1 + num2) / 2;
  }

  private _delta(items: EntityCachePoints): number | null {
    const max = this._maximum(items);
    const min = this._minimum(items);
    return max === null || min === null ? null : max - min;
  }

  private _diff(items: EntityCachePoints): number | null {
    const noNulls = this._filterNulls(items);
    const first = this._first(noNulls);
    const last = this._last(noNulls);
    if (first === null || last === null || Array.isArray(first) || Array.isArray(last)) {
      return null;
    }
    return last - first;
  }

  private _minmax(items: EntityCachePoints): [number, number] | null {
    const min = this._minimum(items);
    const max = this._maximum(items);
    if (min === null || max === null) {
      return null;
    }
    return [min, max];
  }

  private _filterNulls(items: EntityCachePoints): EntityCachePoints {
    return items.filter((item) => item[1] !== null);
  }
}
