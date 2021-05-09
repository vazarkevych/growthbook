import { MetricInterface } from "../../types/metric";
import {
  DataSourceSettings,
  DataSourceProperties,
} from "../../types/datasource";
import {
  ExperimentResults,
  ImpactEstimationResult,
  MetricValueParams,
  UsersQueryParams,
  MetricValueResult,
  UsersResult,
  SourceIntegrationInterface,
  VariationMetricResult,
  PastExperimentResult,
} from "../types/Integration";
import sqlFormatter from "sql-formatter";
import { ExperimentPhase, ExperimentInterface } from "../../types/experiment";
import { DimensionInterface } from "../../types/dimension";
import { SegmentInterface } from "../../types/segment";

const percentileNumbers = [
  0.01,
  0.05,
  0.1,
  0.2,
  0.3,
  0.4,
  0.5,
  0.6,
  0.7,
  0.8,
  0.9,
  0.95,
  0.99,
];

type UsersQueryResponse = {
  date?: string;
  users: string;
}[];
type MetricValueQueryResponse = {
  date?: string;
  count: string;
  mean: string;
  stddev: string;
}[];
type PastExperimentResponse = {
  experiment_id: string;
  variation_id: string;
  start_date: string;
  end_date: string;
  users: string;
}[];

export default abstract class SqlIntegration
  implements SourceIntegrationInterface {
  settings: DataSourceSettings;
  datasource: string;
  organization: string;
  abstract setParams(encryptedParams: string): void;
  // eslint-disable-next-line
  abstract runQuery(sql: string): Promise<any[]>;
  abstract percentile(col: string, percentile: number): string;
  // eslint-disable-next-line
  abstract getNonSensitiveParams(): any;
  constructor(encryptedParams: string, settings: DataSourceSettings) {
    // TODO: new connection params for bigquery
    this.setParams(encryptedParams);
    this.settings = {
      default: {
        timestampColumn: "received_at",
        userIdColumn: "user_id",
        ...settings.default,
      },
      experiments: {
        experimentIdColumn: "experiment_id",
        table: "experiment_viewed",
        variationColumn: "variation_id",
        variationFormat: "index",
        ...settings.experiments,
      },
      users: {
        table: "users",
        ...settings.users,
      },
      pageviews: {
        table: "pages",
        urlColumn: "path",
        ...settings.pageviews,
      },
      identifies: {
        table: "identifies",
        ...settings.identifies,
      },
    };
  }

  getSourceProperties(): DataSourceProperties {
    return {
      includeInConfig: true,
      readonlyFields: [],
      type: "database",
      queryLanguage: "sql",
      metricCaps: true,
    };
  }

  async testConnection(): Promise<boolean> {
    await this.runQuery("select 1");
    return true;
  }

  getFullTableName(table: string): string {
    return table;
  }
  toTimestamp(date: Date) {
    return `'${date.toISOString().substr(0, 19).replace("T", " ")}'`;
  }
  addDateInterval(col: string, days: number) {
    return `${col} + INTERVAL '${days} days'`;
  }
  subtractHalfHour(col: string) {
    return `${col} - INTERVAL '30 minutes'`;
  }
  regexMatch(col: string, regex: string) {
    return `${col} ~ '${regex}'`;
  }
  dateTrunc(col: string) {
    return `date_trunc('day', ${col})`;
  }
  dateDiff(startCol: string, endCol: string) {
    return `datediff(day, ${startCol}, ${endCol})`;
  }

  getPastExperimentQuery(from: Date) {
    return sqlFormatter.format(`-- Past Experiments
    WITH
      __experimentDates as (
        SELECT
          ${
            this.settings?.experiments?.experimentIdColumn || "experiment_id"
          } as experiment_id,
          ${this.getVariationColumn()} as variation_id,
          ${this.dateTrunc(
            this.getTimestampColumn(null, "experiments")
          )} as date,
          count(distinct ${this.getAnonymousIdColumn(
            null,
            "experiments"
          )}) as users
        FROM
          ${this.getFullTableName(
            this.settings?.experiments?.table || "experiment_viewed"
          )}
        WHERE
          ${this.getTimestampColumn(null, "experiments")} > ${this.toTimestamp(
      from
    )}
        GROUP BY
          ${this.settings?.experiments?.experimentIdColumn || "experiment_id"},
          ${this.getVariationColumn()},
          ${this.dateTrunc(this.getTimestampColumn(null, "experiments"))}
      ),
      __userThresholds as (
        SELECT
          experiment_id,
          variation_id,
          -- It's common for a small number of tracking events to continue coming in
          -- long after an experiment ends, so limit to days with enough traffic
          max(users)*0.05 as threshold
        FROM
          __experimentDates
        WHERE
          -- Skip days where a variation got 5 or fewer visitors since it's probably not real traffic
          users > 5
        GROUP BY
          experiment_id, variation_id
      ),
      __variations as (
        SELECT
          d.experiment_id,
          d.variation_id,
          MIN(d.date) as start_date,
          MAX(d.date) as end_date,
          SUM(d.users) as users
        FROM
          __experimentDates d
          JOIN __userThresholds u ON (
            d.users > u.threshold
            AND d.experiment_id = u.experiment_id
            AND d.variation_id = u.variation_id
          )
        GROUP BY
          d.experiment_id, d.variation_id
      )
    SELECT
      *
    FROM
      __variations
    WHERE
      -- Skip experiments with fewer than 200 users since they don't have enough data
      users > 200
      -- Skip experiments that are 5 days or shorter (most likely means it was stopped early)
      AND ${this.dateDiff("start_date", "end_date")} > 5
      -- Skip experiments that start of the very first day since we're likely missing data
      AND ${this.dateDiff(this.toTimestamp(from), "start_date")} > 2
    ORDER BY
      experiment_id ASC, variation_id ASC`);
  }
  async runPastExperimentQuery(query: string): Promise<PastExperimentResult> {
    const rows: PastExperimentResponse = await this.runQuery(query);

    return {
      experiments: rows.map((r) => {
        return {
          users: parseInt(r.users),
          end_date: new Date(r.end_date),
          start_date: new Date(r.start_date),
          experiment_id: r.experiment_id,
          variation_id: r.variation_id,
        };
      }),
    };
  }

  getMetricValueQuery(params: MetricValueParams): string {
    const userId = params.userIdType === "user";

    // TODO: support by date
    return sqlFormatter.format(`-- ${params.name} - ${params.metric.name} Metric
      WITH
        __users as (${this.getPageUsersCTE(params, userId)})
        ${
          params.segmentQuery
            ? `, segment as (${this.getSegmentCTE(
                params.segmentQuery,
                params.segmentName,
                userId
              )})`
            : ""
        }
        , __metric as (${this.getMetricCTE(
          params.metric,
          params.conversionWindow,
          userId
        )})
        , __distinctUsers as (
          SELECT
            u.user_id,
            MIN(u.conversion_end) as conversion_end,
            MIN(u.session_start) as session_start,
            MIN(u.actual_start) as actual_start
          FROM
            __users u
            ${
              params.segmentQuery
                ? "JOIN segment s ON (s.user_id = u.user_id AND s.date <= u.actual_start)"
                : ""
            }
          GROUP BY
            u.user_id
        )
        , __userMetric as (
          -- Add in the aggregate metric value for each user
          SELECT
            ${this.getAggregateMetricSqlValue(params.metric)} as value
          FROM
            __distinctUsers d
            JOIN __metric m ON (
              m.user_id = d.user_id
              AND m.actual_start >= d.${
                params.metric.earlyStart ? "session_start" : "actual_start"
              }
              AND m.actual_start <= d.conversion_end
            )
          GROUP BY
            d.user_id
        )
        ${
          params.includeByDate
            ? `
          , __userMetricDates as (
            -- Add in the aggregate metric value for each user
            SELECT
              ${this.dateTrunc("d.actual_start")} as date,
              ${this.getAggregateMetricSqlValue(params.metric)} as value
            FROM
              __distinctUsers d
              JOIN __metric m ON (
                m.user_id = d.user_id
                AND m.actual_start >= d.${
                  params.metric.earlyStart ? "session_start" : "actual_start"
                }
                AND m.actual_start <= d.conversion_end
              )
            GROUP BY
              ${this.dateTrunc("d.actual_start")},
              d.user_id
          )`
            : ""
        }
      SELECT
        ${params.includeByDate ? "null as date," : ""}
        COUNT(*) as count,
        AVG(value) as mean,
        STDDEV(value) as stddev
        ${
          params.includePercentiles && params.metric.type !== "binomial"
            ? `,${percentileNumbers
                .map(
                  (n) =>
                    `${this.percentile("value", n)} as p${Math.floor(n * 100)}`
                )
                .join("\n      ,")}`
            : ""
        }
      from
        __userMetric
      ${
        params.includeByDate
          ? `
        UNION SELECT
          date,
          COUNT(*) as count,
          AVG(value) as mean,
          STDDEV(value) as stddev
          ${
            params.includePercentiles && params.metric.type !== "binomial"
              ? `,${percentileNumbers
                  .map((n) => `0 as p${Math.floor(n * 100)}`)
                  .join("\n      ,")}`
              : ""
          }
        FROM
          __userMetricDates d
        GROUP BY
          date
        ORDER BY
          date ASC
      `
          : ""
      }
      `);
  }

  getUsersQuery(params: UsersQueryParams): string {
    const userId = params.userIdType === "user";

    return sqlFormatter.format(`-- ${params.name} - Number of Users
      WITH
        __users as (${this.getPageUsersCTE(params, userId)})
        ${
          params.segmentQuery
            ? `, __segment as (${this.getSegmentCTE(
                params.segmentQuery,
                params.segmentName,
                userId
              )})`
            : ""
        }
      SELECT
        ${params.includeByDate ? "null as date," : ""}
        COUNT(DISTINCT u.user_id) as users
      FROM
        __users u
        ${
          params.segmentQuery
            ? "JOIN __segment s ON (s.user_id = u.user_id AND s.date <= u.actual_start)"
            : ""
        }

      ${
        params.includeByDate
          ? `
        UNION SELECT
          ${this.dateTrunc("u.actual_start")} as date,
          COUNT(DISTINCT u.user_id) as users
        FROM
          __users u
          ${
            params.segmentQuery
              ? "JOIN __segment s ON (s.user_id = u.user_id AND s.date <= u.actual_start)"
              : ""
          }
        GROUP BY
          ${this.dateTrunc("u.actual_start")}
        ORDER BY
          date asc
      `
          : ""
      }
      `);
  }
  async runUsersQuery(query: string): Promise<UsersResult> {
    const rows: UsersQueryResponse = await this.runQuery(query);
    const ret: UsersResult = {
      users: 0,
    };
    rows.forEach((row) => {
      const { users, date } = row;
      if (date) {
        ret.dates = ret.dates || [];
        ret.dates.push({
          date,
          users: parseInt(users) || 0,
        });
      } else {
        ret.users = parseInt(users) || 0;
      }
    });

    return ret;
  }
  async runMetricValueQuery(query: string): Promise<MetricValueResult> {
    const rows = await this.runQuery(query);

    const ret: MetricValueResult = { count: 0, mean: 0, stddev: 0 };

    rows.forEach((row) => {
      const { date, count, mean, stddev, ...percentiles } = row;

      // Row for each date
      if (date) {
        ret.dates = ret.dates || [];
        ret.dates.push({
          date,
          count: parseInt(count) || 0,
          mean: parseFloat(mean) || 0,
          stddev: parseFloat(stddev) || 0,
        });
      }
      // Overall numbers
      else {
        ret.count = parseInt(count) || 0;
        ret.mean = parseFloat(mean) || 0;
        ret.stddev = parseFloat(stddev) || 0;

        if (percentiles) {
          Object.keys(percentiles).forEach((p) => {
            ret.percentiles = ret.percentiles || {};
            ret.percentiles[p.replace(/^p/, "")] =
              parseInt(percentiles[p]) || 0;
          });
        }
      }
    });

    return ret;
  }

  async getImpactEstimation(
    urlRegex: string,
    metric: MetricInterface,
    segment?: SegmentInterface
  ): Promise<ImpactEstimationResult> {
    const numDays = 30;

    // Ignore last 3 days of data since we need to give people time to convert
    const end = new Date();
    end.setDate(end.getDate() - 3);
    const start = new Date();
    start.setDate(start.getDate() - numDays - 3);

    const baseSettings = {
      from: start,
      to: end,
      includeByDate: false,
      userIdType: metric.userIdType,
      conversionWindow: 3,
    };

    const usersSql = this.getUsersQuery({
      ...baseSettings,
      name: "Traffic - Selected Pages and Segment",
      urlRegex,
      segmentQuery: segment?.sql || null,
      segmentName: segment?.name,
    });
    const metricSql = this.getMetricValueQuery({
      ...baseSettings,
      name: "Metric Value - Entire Site",
      metric,
      includePercentiles: false,
    });
    const valueSql = this.getMetricValueQuery({
      ...baseSettings,
      name: "Metric Value - Selected Pages and Segment",
      metric,
      includePercentiles: false,
      urlRegex,
      segmentQuery: segment?.sql || null,
      segmentName: segment?.name,
    });

    const [users, metricTotal, value]: [
      UsersQueryResponse,
      MetricValueQueryResponse,
      MetricValueQueryResponse
    ] = await Promise.all([
      this.runQuery(usersSql),
      this.runQuery(metricSql),
      this.runQuery(valueSql),
    ]);

    const formatted =
      [usersSql, metricSql, valueSql]
        .map((sql) => sqlFormatter.format(sql))
        .join(";\n\n") + ";";

    if (
      users &&
      metricTotal &&
      value &&
      users[0] &&
      metricTotal[0] &&
      value[0]
    ) {
      return {
        query: formatted,
        users: (parseInt(users[0].users) || 0) / numDays,
        value:
          (parseInt(value[0].count) * parseFloat(value[0].mean) || 0) / numDays,
        metricTotal:
          (parseInt(metricTotal[0].count) * parseFloat(metricTotal[0].mean) ||
            0) / numDays,
      };
    }

    return {
      query: formatted,
      users: 0,
      value: 0,
      metricTotal: 0,
    };
  }

  getIdentifiesJoinSql(column: string, userId: boolean = true) {
    const identifiesColumn = userId
      ? this.getUserIdColumn(null, "identifies")
      : this.getAnonymousIdColumn(null, "identifies");

    return `JOIN ${this.getFullTableName(
      this.settings?.identifies?.table || "identifies"
    )} i ON (
      i.${identifiesColumn} = ${column}
    )`;
  }

  getExperimentUsersSql(
    experiment: ExperimentInterface,
    phase: ExperimentPhase,
    activationMetric: MetricInterface | null,
    dimension: DimensionInterface | null
  ) {
    if (experiment.sqlOverride && experiment.sqlOverride.has("users")) {
      return experiment.sqlOverride
        .get("users")
        .replace(/{{\s*dateStart\s*}}/g, this.toTimestamp(phase.dateStarted))
        .replace(
          /{{\s*dateEnd\s*}}/g,
          this.toTimestamp(phase.dateEnded || new Date())
        )
        .replace(/{{\s*experimentKey\s*}}/g, `'${experiment.trackingKey}'`);
    }

    const userId = experiment.userIdType === "user";

    return `-- Number of users in experiment
    WITH
      __experiment as (${this.getExperimentCTE(experiment, phase, userId)})
      ${
        dimension
          ? `, __dimension as (${this.getDimensionCTE(dimension, userId)})`
          : ""
      }
      ${
        activationMetric
          ? `, __activationMetric as (${this.getMetricCTE(
              activationMetric,
              experiment.conversionWindowDays,
              userId
            )})`
          : ""
      }
      , __distinctUsers as (
        -- One row per user/dimension/variation
        SELECT
          e.user_id,
          e.variation,
          ${dimension ? "d.value" : "'All'"} as dimension
        FROM
          __experiment e
          ${dimension ? "JOIN __dimension d ON (d.user_id = e.user_id)" : ""}
          ${
            activationMetric
              ? `
          JOIN __activationMetric a ON (
            a.user_id = e.user_id
            AND a.actual_start >= e.actual_start
            AND a.actual_start <= e.conversion_end
          )`
              : ""
          }
        GROUP BY
          variation, dimension, e.user_id
      )
    -- Count of distinct users in experiment per variation/dimension
    SELECT
      variation,
      dimension,
      COUNT(*) as users
    FROM
      __distinctUsers
    GROUP BY
      variation,
      dimension
    `;
  }
  getExperimentMetricSql(
    metric: MetricInterface,
    experiment: ExperimentInterface,
    phase: ExperimentPhase,
    activationMetric: MetricInterface | null,
    dimension: DimensionInterface | null
  ): string {
    if (experiment.sqlOverride && experiment.sqlOverride.has(metric.id)) {
      return experiment.sqlOverride
        .get(metric.id)
        .replace(/{{\s*dateStart\s*}}/g, this.toTimestamp(phase.dateStarted))
        .replace(
          /{{\s*dateEnd\s*}}/g,
          this.toTimestamp(phase.dateEnded || new Date())
        )
        .replace(/{{\s*experimentKey\s*}}/g, `'${experiment.trackingKey}'`);
    }

    const userId = experiment.userIdType === "user";

    return `-- ${metric.name} (${metric.type})
    WITH
      __experiment as (${this.getExperimentCTE(experiment, phase, userId)})
      , __metric as (${this.getMetricCTE(
        metric,
        experiment.conversionWindowDays,
        userId
      )})
      ${
        dimension
          ? `, __dimension as (${this.getDimensionCTE(dimension, userId)})`
          : ""
      }
      ${
        activationMetric
          ? `, __activationMetric as (${this.getMetricCTE(
              activationMetric,
              experiment.conversionWindowDays,
              userId
            )})`
          : ""
      }
      , __distinctUsers as (
        -- One row per user/dimension/variation
        SELECT
          e.user_id,
          e.variation,
          ${dimension ? "d.value" : "'All'"} as dimension,
          MIN(${activationMetric ? "a" : "e"}.actual_start) as actual_start,
          MIN(${activationMetric ? "a" : "e"}.session_start) as session_start,
          MIN(${activationMetric ? "a" : "e"}.conversion_end) as conversion_end
        FROM
          __experiment e
          ${dimension ? "JOIN __dimension d ON (d.user_id = e.user_id)" : ""}
          ${
            activationMetric
              ? `
          JOIN __activationMetric a ON (
            a.user_id = e.user_id
            AND a.actual_start >= e.actual_start
            AND a.actual_start <= e.conversion_end
          )`
              : ""
          }
        GROUP BY
          variation, dimension, e.user_id
      )
      , __userMetric as (
        -- Add in the aggregate metric value for each user
        SELECT
          d.variation,
          d.dimension,
          ${this.getAggregateMetricSqlValue(metric)} as value
        FROM
          __distinctUsers d
          JOIN __metric m ON (
            m.user_id = d.user_id
            AND m.actual_start >= d.${
              metric.earlyStart ? "session_start" : "actual_start"
            }
            AND m.actual_start <= d.conversion_end
          )
        GROUP BY
          variation, dimension, d.user_id
      )
    -- Sum all user metrics together to get a total per variation/dimension
    SELECT
      variation,
      dimension,
      COUNT(*) as count,
      AVG(value) as mean,
      STDDEV(value) as stddev
    FROM
      __userMetric
    GROUP BY
      variation,
      dimension
    `;
  }
  async getExperimentResults(
    experiment: ExperimentInterface,
    phase: ExperimentPhase,
    metrics: MetricInterface[],
    activationMetric: MetricInterface | null,
    dimension: DimensionInterface | null
  ): Promise<ExperimentResults> {
    const variationKeyMap = new Map<string, number>();
    experiment.variations.forEach((v, i) => {
      variationKeyMap.set(v.key, i);
    });

    const dimensionMap = new Map<
      string,
      { variation: number; users: number; metrics: VariationMetricResult[] }[]
    >();

    const query: string[] = [];

    const getDimensionData = (key: string, variation: number) => {
      let obj = dimensionMap.get(key);
      if (!obj) {
        obj = [];
        dimensionMap.set(key, obj);
      }

      if (!obj[variation]) {
        obj[variation] = {
          variation,
          users: 0,
          metrics: [],
        };
      }

      return obj[variation];
    };

    const promises = metrics.map(async (m) => {
      const sql = this.getExperimentMetricSql(
        m,
        experiment,
        phase,
        activationMetric,
        dimension
      );
      query.push(sql);
      const rows: {
        variation: string;
        dimension: string;
        count: string;
        mean: string;
        stddev: string;
      }[] = await this.runQuery(sql);

      rows.forEach(({ variation, dimension, count, mean, stddev }) => {
        const varIndex =
          this.settings?.experiments?.variationFormat === "key"
            ? variationKeyMap.get(variation)
            : parseInt(variation);

        if (varIndex < 0 || varIndex >= experiment.variations.length) {
          console.log("Unexpected variation", variation);
          return;
        }

        const data = getDimensionData(dimension, varIndex);
        data.metrics.push({
          metric: m.id,
          count: parseInt(count) || 0,
          mean: parseFloat(mean) || 0,
          stddev: parseFloat(stddev) || 0,
        });
      });
    });

    // Users query
    promises.push(
      (async () => {
        const sql = this.getExperimentUsersSql(
          experiment,
          phase,
          activationMetric,
          dimension
        );
        query.push(sql);
        const rows: {
          variation: string;
          users: string;
          dimension: string;
        }[] = await this.runQuery(sql);
        rows.forEach(({ variation, dimension, users }) => {
          const varIndex =
            this.settings?.experiments?.variationFormat === "key"
              ? variationKeyMap.get(variation)
              : parseInt(variation);
          if (varIndex < 0 || varIndex >= experiment.variations.length) {
            console.log("Unexpected variation", variation);
            return;
          }

          const data = getDimensionData(dimension, varIndex);
          data.users = parseInt(users) || 0;
        });
      })()
    );

    await Promise.all(promises);

    const results: ExperimentResults = {
      results: [],
      query: query.map((q) => sqlFormatter.format(q)).join(";\n\n") + ";",
    };

    dimensionMap.forEach((variations, k) => {
      results.results.push({
        dimension: k,
        variations,
      });
    });
    return results;
  }

  getMetricCTE(
    metric: MetricInterface,
    conversionWindowDays: number,
    userId: boolean = true
  ) {
    let userIdCol: string;
    let join = "";
    // Need to use userId, but metric is anonymous only
    if (userId && metric.userIdType === "anonymous") {
      userIdCol = "i.user_id";
      join = this.getIdentifiesJoinSql(
        "m." + this.getAnonymousIdColumn(metric),
        false
      );
    }
    // Need to use anonymousId, but metric is user only
    else if (!userId && metric.userIdType === "user") {
      userIdCol = "i.user_id";
      join = this.getIdentifiesJoinSql(
        "m." + this.getUserIdColumn(metric),
        true
      );
    }
    // Otherwise, can query the metric directly
    else {
      userIdCol =
        "m." +
        (userId
          ? this.getUserIdColumn(metric)
          : this.getAnonymousIdColumn(metric));
    }

    const timestampCol = "m." + this.getTimestampColumn(metric);

    return `-- Metric (${metric.name})
      SELECT
        ${userIdCol} as user_id,
        ${this.getRawMetricSqlValue(metric, "m")} as value,
        ${timestampCol} as actual_start,
        ${this.addDateInterval(
          timestampCol,
          conversionWindowDays
        )} as conversion_end,
        ${this.subtractHalfHour(timestampCol)} as session_start
      FROM
        ${this.getFullTableName(metric.table)} m
        ${join}
      ${
        metric.conditions.length
          ? `WHERE ${metric.conditions
              .map((c) => `m.${c.column} ${c.operator} '${c.value}'`)
              .join(" AND ")}`
          : ""
      }
    `;
  }
  getExperimentCTE(
    experiment: ExperimentInterface,
    phase: ExperimentPhase,
    userId: boolean = true
  ) {
    let userIdCol: string;
    let join = "";
    // Need to use userId, but experiment is anonymous only
    if (userId && experiment.userIdType === "anonymous") {
      userIdCol = "i.user_id";
      join = this.getIdentifiesJoinSql(
        "m." + this.getAnonymousIdColumn(null, "experiments"),
        false
      );
    }
    // Need to use anonymousId, but experiment is user only
    else if (!userId && experiment.userIdType === "user") {
      userIdCol = "i.user_id";
      join = this.getIdentifiesJoinSql(
        "m." + this.getUserIdColumn(null, "experiments"),
        true
      );
    }
    // Otherwise, can query the experiment directly
    else {
      userIdCol = userId
        ? this.getUserIdColumn(null, "experiments")
        : this.getAnonymousIdColumn(null, "experiments");
    }

    const timestampCol = "e." + this.getTimestampColumn(null, "experiments");

    return `-- Viewed Experiment
    SELECT
      ${userIdCol} as user_id,
      e.${this.getVariationColumn()} as variation,
      ${timestampCol} as actual_start,
      ${this.addDateInterval(
        timestampCol,
        experiment.conversionWindowDays
      )} as conversion_end,
      ${this.subtractHalfHour(timestampCol)} as session_start
    FROM
      ${this.getFullTableName(
        this.settings?.experiments?.table || "experiment_viewed"
      )} e
      ${join}
    WHERE
      e.${
        this.settings?.experiments?.experimentIdColumn || "experiment_id"
      } = '${experiment.trackingKey}'
      AND ${timestampCol} >= ${this.toTimestamp(phase.dateStarted)}
      ${
        phase.dateEnded
          ? `AND ${timestampCol} <= ${this.toTimestamp(phase.dateEnded)}`
          : ""
      }
    `;
  }
  getSegmentCTE(sql: string, name: string, userId: boolean = true) {
    // Need to map user_id to anonymous_id
    if (!userId) {
      return `-- Segment (${name})
      SELECT
        i.user_id,
        s.date
      FROM
        (${sql}) s
        ${this.getIdentifiesJoinSql("s.user_id", true)}
      `;
    }

    return `-- Segment (${name})
    ${sql}
    `;
  }

  getDimensionCTE(dimension: DimensionInterface, userId: boolean = true) {
    // Need to map user_id to anonymous_id
    if (!userId) {
      return `-- Dimension (${dimension.name})
      SELECT
        i.user_id,
        d.value
      FROM
        (${dimension.sql}) d
        ${this.getIdentifiesJoinSql("d.user_id", true)}
      `;
    }

    return `-- Dimension (${dimension.name})
    ${dimension.sql}
    `;
  }

  getPageUsersCTE(
    params: MetricValueParams | UsersQueryParams,
    userId: boolean = true
  ): string {
    const timestampCol = this.getTimestampColumn(null, "pageviews");
    // TODO: use identifies if table is missing the requested userId type
    const userIdCol = userId
      ? this.getUserIdColumn(null, "pageviews")
      : this.getAnonymousIdColumn(null, "pageviews");

    return `-- Users visiting specific pages
    SELECT
      ${userIdCol} as user_id,
      MIN(${timestampCol}) as actual_start,
      ${this.addDateInterval(
        `MIN(${timestampCol})`,
        params.conversionWindow
      )} as conversion_end,
      ${this.subtractHalfHour(`MIN(${timestampCol})`)} as session_start
    FROM
      ${this.getFullTableName(this.settings.pageviews?.table || "pages")}
    WHERE
      ${timestampCol} >= ${this.toTimestamp(this.dateOnly(params.from))}
      AND ${timestampCol} <= ${this.toTimestamp(this.dateOnly(params.to))}
      ${
        params.urlRegex && params.urlRegex !== ".*"
          ? `AND ${this.regexMatch(
              this.settings.pageviews?.urlColumn || "path",
              params.urlRegex
            )}`
          : ""
      }
    GROUP BY
      ${userIdCol}
    `;
  }

  dateOnly(orig: Date) {
    const date = new Date(orig);

    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);

    return date;
  }

  capValue(cap: number, value: string) {
    if (!cap) {
      return value;
    }

    return `LEAST(${cap}, ${value})`;
  }

  getMetricColumn(metric: MetricInterface, alias = "m") {
    if (metric.type === "duration") {
      // Custom SQL column expression
      if (metric.column.match(/\{alias\}/)) {
        return metric.column.replace(/\{alias\}/g, alias);
      }
    }
    return alias + "." + metric.column;
  }

  getRawMetricSqlValue(metric: MetricInterface, alias: string = "m") {
    if (metric.type === "count") {
      return metric.column ? this.getMetricColumn(metric, alias) : "1";
    } else if (metric.type === "duration") {
      return this.getMetricColumn(metric, alias);
    } else if (metric.type === "revenue") {
      return this.getMetricColumn(metric, alias);
    }
    return "1";
  }
  getAggregateMetricSqlValue(metric: MetricInterface, col: string = "m.value") {
    if (metric.type === "count") {
      return this.capValue(
        metric.cap,
        `COUNT(${metric.column ? `DISTINCT ${col}` : "*"})`
      );
    } else if (metric.type === "duration") {
      return this.capValue(metric.cap, `MAX(${col})`);
    } else if (metric.type === "revenue") {
      return this.capValue(metric.cap, `MAX(${col})`);
    }
    return "1";
  }
  getUserIdColumn(
    metric: null | MetricInterface,
    section:
      | "experiments"
      | "pageviews"
      | "users"
      | "identifies"
      | "default" = "default"
  ): string {
    return (
      (metric && metric.userIdColumn) ||
      this.settings[section]?.userIdColumn ||
      this.settings?.default?.userIdColumn ||
      "user_id"
    );
  }
  getAnonymousIdColumn(
    metric: null | MetricInterface,
    section: "experiments" | "pageviews" | "identifies" | "default" = "default"
  ): string {
    return (
      (metric && metric.anonymousIdColumn) ||
      this.settings[section]?.anonymousIdColumn ||
      this.settings?.default?.anonymousIdColumn ||
      "anonymous_id"
    );
  }
  getTimestampColumn(
    metric: null | MetricInterface,
    section: "experiments" | "pageviews" | "default" = "default"
  ): string {
    return (
      (metric && metric.timestampColumn) ||
      this.settings[section]?.timestampColumn ||
      this.settings?.default?.timestampColumn ||
      "received_at"
    );
  }
  getVariationColumn() {
    return this.settings?.experiments?.variationColumn || "variation_id";
  }
}