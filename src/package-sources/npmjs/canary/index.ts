import { Duration } from 'aws-cdk-lib';
import { MetricOptions, Metric, Statistic } from 'aws-cdk-lib/aws-cloudwatch';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { gravitonLambdaIfAvailable } from '../../../backend/_lambda-architecture';
import {
  Environment,
  ObjectKey,
  METRICS_NAMESPACE,
  MetricName,
} from './constants';
import { NpmjsPackageCanary as Handler } from './npmjs-package-canary';

export interface NpmJsPackageCanaryProps {
  readonly bucket: IBucket;
  readonly constructHubBaseUrl: string;
  readonly packageName: string;
}

export class NpmJsPackageCanary extends Construct {
  private readonly handler: Handler;

  public constructor(
    scope: Construct,
    id: string,
    props: NpmJsPackageCanaryProps
  ) {
    super(scope, id);

    this.handler = new Handler(this, 'Resource', {
      architecture: gravitonLambdaIfAvailable(this),
      description: `[${scope.node.path}/PackageCanary] Monitors ${props.packageName} versions availability`,
      environment: {
        AWS_EMF_ENVIRONMENT: 'Local',
        [Environment.CONSTRUCT_HUB_BASE_URL]: props.constructHubBaseUrl,
        [Environment.PACKAGE_CANARY_BUCKET_NAME]: props.bucket.bucketName,
        [Environment.PACKAGE_NAME]: props.packageName,
      },
      memorySize: 10_024,
      timeout: Duration.minutes(1),
    });
    const grant = props.bucket.grantReadWrite(
      this.handler,
      `${ObjectKey.STATE_PREFIX}*${ObjectKey.STATE_SUFFIX}`
    );

    const schedule = new Rule(this, 'Schedule', {
      description: 'Scheduled executions of the NpmJS package canary',
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(this.handler)],
    });
    // Ensure we don't attempt to run before permissions have been granted.
    schedule.node.addDependency(grant);
  }

  public metricDwellTime(opts?: MetricOptions): Metric {
    return new Metric({
      period: Duration.minutes(1),
      statistic: Statistic.MAXIMUM,
      ...opts,
      metricName: MetricName.DWELL_TIME,
      namespace: METRICS_NAMESPACE,
    });
  }

  public metricTimeToCatalog(opts?: MetricOptions): Metric {
    return new Metric({
      period: Duration.minutes(1),
      statistic: Statistic.MAXIMUM,
      ...opts,
      metricName: MetricName.TIME_TO_CATALOG,
      namespace: METRICS_NAMESPACE,
    });
  }

  public metricTrackedVersionCount(opts?: MetricOptions): Metric {
    return new Metric({
      period: Duration.minutes(1),
      statistic: Statistic.MAXIMUM,
      ...opts,
      metricName: MetricName.TRACKED_VERSION_COUNT,
      namespace: METRICS_NAMESPACE,
    });
  }

  /**
   * The estimated lag between the npm registry replica (replcate.npmjs.com) and
   * the primary registry (registry.npmjs.com).
   *
   * IMPORTANT NOTE: This is based on the difference in modified timestamps for
   * the probe package between the two and hence has a granularly no better than
   * the publishing interval of this. Since the construct-hub-probe package is
   * only published every 3 hours approximately, this metric has a resolution
   * that is strictly worse than 3 hours.
   */
  public metricEstimatedNpmReplicaLag(opts?: MetricOptions): Metric {
    return new Metric({
      period: Duration.minutes(1),
      statistic: Statistic.MAXIMUM,
      ...opts,
      metricName: MetricName.NPM_REPLICA_LAG,
      namespace: METRICS_NAMESPACE,
    });
  }

  public metricErrors(opts?: MetricOptions): Metric {
    return this.handler.metricErrors(opts);
  }

  public metricInvocations(opts?: MetricOptions): Metric {
    return this.handler.metricInvocations(opts);
  }

  public metricThrottles(opts?: MetricOptions): Metric {
    return this.handler.metricThrottles(opts);
  }

  public metricDuration(opts?: MetricOptions): Metric {
    return this.handler.metricDuration(opts);
  }
}
