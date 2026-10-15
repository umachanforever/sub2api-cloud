-- Expose only the subscription DTO through the service-role-only RPC.
alter function public.s2a_subscription_dto(uuid,boolean) security definer;
