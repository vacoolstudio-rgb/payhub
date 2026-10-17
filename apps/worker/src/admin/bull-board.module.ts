import { Module } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullModule } from '@nestjs/bullmq';
import { QueueName } from '@payhub/queue';

/**
 * Bull Board.
 *
 * Mounted on the worker's internal HTTP port, which is never exposed
 * through the public ingress — the board can retry, promote and delete
 * jobs, so it is an admin surface, not a dashboard. In a cluster it sits
 * behind the same auth proxy as Grafana.
 */
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
      boardOptions: {
        uiConfig: {
          boardTitle: 'PayHub Queues',
        },
      },
    }),
    BullModule.registerQueue({ name: QueueName.WebhookDelivery }),
    BullBoardModule.forFeature({
      name: QueueName.WebhookDelivery,
      adapter: BullMQAdapter,
    }),
  ],
})
export class QueueAdminModule {}
