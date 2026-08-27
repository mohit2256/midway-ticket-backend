import { Global, Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";

// @Global so any module (bookings, tickets, analytics) can inject
// RealtimeGateway without importing RealtimeModule everywhere.
@Global()
@Module({
  providers: [RealtimeGateway],
  exports:   [RealtimeGateway],
})
export class RealtimeModule {}
