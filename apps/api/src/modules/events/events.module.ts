import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.service';
import { EventDispatcher } from './event-dispatcher.service';

@Global()
@Module({
  providers: [EventBus, EventDispatcher],
  exports: [EventBus, EventDispatcher],
})
export class EventsModule {}
