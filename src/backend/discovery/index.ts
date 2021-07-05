import { ComparisonOperator, IAlarm, IMetric, Metric, MetricOptions, Statistic } from '@aws-cdk/aws-cloudwatch';
import { Rule, Schedule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { RetentionDays } from '@aws-cdk/aws-logs';
import { BlockPublicAccess, Bucket, IBucket } from '@aws-cdk/aws-s3';
import { IQueue } from '@aws-cdk/aws-sqs';

import { Construct, Duration } from '@aws-cdk/core';
import { Monitoring } from '../../monitoring';
import { MetricName, METRIC_NAMESPACE, S3KeyPrefix } from './constants.lambda-shared';
import { Discovery as Handler } from './discovery';

export interface DiscoveryProps {
  /**
   * The monitoring handler to register alarms with.
   */
  readonly monitoring: Monitoring;

  /**
   * The queue to post package updated messages to
   */
  readonly queue: IQueue;

  /**
   * How long should execution logs be retained?
   *
   * @default RetentionDays.TEN_YEARS
   */
  readonly logRetention?: RetentionDays;
}

/**
 * This discovery function periodically scans the CouchDB replica of npmjs.com
 * to discover newly published packages that are relevant for indexing in the
 * Construct Hub, then notifies the ingestion function about those.
 */
export class Discovery extends Construct {
  /**
   * The S3 bucket in which the discovery function stages npm packages.
   */
  public readonly bucket: IBucket;

  /**
   * Alarms if the discovery function does not complete successfully.
   */
  public readonly alarmErrors: IAlarm;

  /**
   * Alarms if the discovery function does not run as expected.
   */
  public readonly alarmNoInvocations: IAlarm;

  private readonly timeout = Duration.minutes(15);

  public constructor(scope: Construct, id: string, props: DiscoveryProps) {
    super(scope, id);

    this.bucket = new Bucket(this, 'StagingBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          prefix: S3KeyPrefix.STAGED_KEY_PREFIX, // delete the staged tarball after 30 days
          expiration: Duration.days(30),
        },
      ],
    });

    // Note: the handler is designed to stop processing more batches about 2 minutes ahead of the timeout.
    const lambda = new Handler(this, 'Default', {
      description: 'Periodically query npm.js index for new construct libraries',
      memorySize: 10_240,
      reservedConcurrentExecutions: 1, // Only one execution (avoids race conditions on the S3 marker object)
      timeout: this.timeout,
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        QUEUE_URL: props.queue.queueUrl,
      },
    });

    this.bucket.grantReadWrite(lambda);
    props.queue.grantSendMessages(lambda);

    new Rule(this, 'ScheduleRule', {
      schedule: Schedule.rate(this.timeout),
      targets: [new LambdaFunction(lambda)],
    });

    props.monitoring.watchful.watchLambdaFunction('Discovery Function', lambda);
    this.alarmErrors = lambda.metricErrors({ period: Duration.minutes(15) }).createAlarm(this, 'ErrorsAlarm', {
      alarmDescription: 'The discovery function (on npmjs.com) failed to run',
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      threshold: 1,
    });
    this.alarmNoInvocations = lambda.metricInvocations({ period: Duration.minutes(15) })
      .createAlarm(this, 'NoInvocationsAlarm', {
        alarmDescription: 'The discovery function (on npmjs.com) is not running as scheduled',
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        threshold: 1,
      });
  }

  /**
   * The average time it took to process a changes batch.
   */
  public metricBatchProcessingTime(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.BATCH_PROCESSING_TIME,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.AVERAGE,
      ...opts,
    });
  }

  /**
   * The total count of changes that were processed.
   */
  public metricChangeCount(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.CHANGE_COUNT,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.SUM,
      ...opts,
    });
  }

  /**
   * The age of the oldest package version that was processed.
   */
  public metricPackageVersionAge(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.PACKAGE_VERSION_AGE,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.MAXIMUM,
      ...opts,
    });
  }

  /**
   * The total count of package versions that were inspected.
   */
  public metricPackageVersionCount(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.PACKAGE_VERSION_COUNT,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.SUM,
      ...opts,
    });
  }

  /**
   * The total count of package versions that were deemed relevant.
   */
  public metricRelevantPackageVersions(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.RELEVANT_PACKAGE_VERSIONS,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.SUM,
      ...opts,
    });
  }

  /**
   * The amount of time that was remaining when the lambda returned in order to
   * avoid hitting a timeout.
   */
  public metricRemainingTime(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.REMAINING_TIME,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.AVERAGE,
      ...opts,
    });
  }

  /**
   * The total count of staging failures.
   */
  public metricStagingFailureCount(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.STAGING_FAILURE_COUNT,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.SUM,
      ...opts,
    });
  }

  /**
   * The average time it took to stage a package to S3.
   */
  public metricStagingTime(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.STAGING_TIME,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.AVERAGE,
      ...opts,
    });
  }

  /**
   * The amount of changes that were not processed due to having an invalid
   * format.
   */
  public metricUnprocessableEntity(opts?: MetricOptions): IMetric {
    return new Metric({
      metricName: MetricName.UNPROCESSABLE_ENTITY,
      namespace: METRIC_NAMESPACE,
      period: this.timeout,
      statistic: Statistic.SUM,
      ...opts,
    });
  }

}
