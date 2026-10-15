create table public.s2a_model_prices (
 platform text not null check(platform in ('openai','anthropic','gemini')),
 model text not null check(length(model) between 1 and 200),
 rates jsonb not null check(jsonb_typeof(rates)='object'),
 updated_at timestamptz not null default now(),
 primary key(platform,model)
);
alter table public.s2a_model_prices enable row level security;
revoke all on public.s2a_model_prices from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_model_prices to service_role;
-- Token rates from the pinned upstream LiteLLM catalog; amounts are USD per token.
insert into public.s2a_model_prices(platform,model,rates) values
('anthropic','claude-3-7-sonnet-20250219','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_read_input_token_cost":3e-07,"input_cost_per_token":3e-06,"output_cost_per_token":1.5e-05}'::jsonb),
('anthropic','claude-3-haiku-20240307','{"cache_creation_input_token_cost":3e-07,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_read_input_token_cost":3e-08,"input_cost_per_token":2.5e-07,"output_cost_per_token":1.25e-06}'::jsonb),
('anthropic','claude-3-opus-20240229','{"cache_creation_input_token_cost":1.875e-05,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_read_input_token_cost":1.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":7.5e-05}'::jsonb),
('anthropic','claude-4-opus-20250514','{"cache_creation_input_token_cost":1.875e-05,"cache_creation_input_token_cost_above_1hr":3e-05,"cache_read_input_token_cost":1.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":7.5e-05}'::jsonb),
('anthropic','claude-4-sonnet-20250514','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_creation_input_token_cost_above_200k_tokens":7.5e-06,"cache_read_input_token_cost":3e-07,"cache_read_input_token_cost_above_200k_tokens":6e-07,"input_cost_per_token":3e-06,"input_cost_per_token_above_200k_tokens":6e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_200k_tokens":2.25e-05}'::jsonb),
('anthropic','claude-haiku-4-5','{"cache_creation_input_token_cost":1.25e-06,"cache_creation_input_token_cost_above_1hr":2e-06,"cache_read_input_token_cost":1e-07,"input_cost_per_token":1e-06,"output_cost_per_token":5e-06}'::jsonb),
('anthropic','claude-haiku-4-5-20251001','{"cache_creation_input_token_cost":1.25e-06,"cache_creation_input_token_cost_above_1hr":2e-06,"cache_read_input_token_cost":1e-07,"input_cost_per_token":1e-06,"output_cost_per_token":5e-06}'::jsonb),
('anthropic','claude-opus-4-1','{"cache_creation_input_token_cost":1.875e-05,"cache_creation_input_token_cost_above_1hr":3e-05,"cache_read_input_token_cost":1.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":7.5e-05}'::jsonb),
('anthropic','claude-opus-4-1-20250805','{"cache_creation_input_token_cost":1.875e-05,"cache_creation_input_token_cost_above_1hr":3e-05,"cache_read_input_token_cost":1.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":7.5e-05}'::jsonb),
('anthropic','claude-opus-4-20250514','{"cache_creation_input_token_cost":1.875e-05,"cache_creation_input_token_cost_above_1hr":3e-05,"cache_read_input_token_cost":1.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":7.5e-05}'::jsonb),
('anthropic','claude-opus-4-5','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-5-20251101','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-6','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-6-20260205','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-6-thinking','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-7','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-7-20260416','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-4-8','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-opus-5','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_above_1hr":1e-05,"cache_read_input_token_cost":5e-07,"input_cost_per_token":5e-06,"output_cost_per_token":2.5e-05}'::jsonb),
('anthropic','claude-sonnet-4-20250514','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_creation_input_token_cost_above_200k_tokens":7.5e-06,"cache_read_input_token_cost":3e-07,"cache_read_input_token_cost_above_200k_tokens":6e-07,"input_cost_per_token":3e-06,"input_cost_per_token_above_200k_tokens":6e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_200k_tokens":2.25e-05}'::jsonb),
('anthropic','claude-sonnet-4-5','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_creation_input_token_cost_above_200k_tokens":7.5e-06,"cache_read_input_token_cost":3e-07,"cache_read_input_token_cost_above_200k_tokens":6e-07,"input_cost_per_token":3e-06,"input_cost_per_token_above_200k_tokens":6e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_200k_tokens":2.25e-05}'::jsonb),
('anthropic','claude-sonnet-4-5-20250929','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_creation_input_token_cost_above_200k_tokens":7.5e-06,"cache_read_input_token_cost":3e-07,"cache_read_input_token_cost_above_200k_tokens":6e-07,"input_cost_per_token":3e-06,"input_cost_per_token_above_200k_tokens":6e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_200k_tokens":2.25e-05}'::jsonb),
('anthropic','claude-sonnet-4-6','{"cache_creation_input_token_cost":3.75e-06,"cache_creation_input_token_cost_above_1hr":6e-06,"cache_read_input_token_cost":3e-07,"input_cost_per_token":3e-06,"output_cost_per_token":1.5e-05}'::jsonb),
('openai','codex-auto-review','{"cache_read_input_token_cost":2e-08,"input_cost_per_token":2e-07,"output_cost_per_token":1.2e-06}'::jsonb),
('gemini','gemini-2.0-flash','{"cache_read_input_token_cost":2.5e-08,"input_cost_per_audio_token":7e-07,"input_cost_per_token":1e-07,"output_cost_per_token":4e-07}'::jsonb),
('gemini','gemini-2.0-flash-001','{"cache_read_input_token_cost":3.75e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_token":1.5e-07,"output_cost_per_token":6e-07}'::jsonb),
('gemini','gemini-2.0-flash-lite','{"cache_read_input_token_cost":1.875e-08,"input_cost_per_audio_token":7.5e-08,"input_cost_per_token":7.5e-08,"output_cost_per_token":3e-07}'::jsonb),
('gemini','gemini-2.0-flash-lite-001','{"cache_read_input_token_cost":1.875e-08,"input_cost_per_audio_token":7.5e-08,"input_cost_per_token":7.5e-08,"output_cost_per_token":3e-07}'::jsonb),
('gemini','gemini-2.5-computer-use-preview-10-2025','{"input_cost_per_token":1.25e-06,"input_cost_per_token_above_200k_tokens":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_above_200k_tokens":1.5e-05}'::jsonb),
('gemini','gemini-2.5-flash','{"cache_read_input_token_cost":3e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_reasoning_token":2.5e-06,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-2.5-flash-lite','{"cache_read_input_token_cost":1e-08,"input_cost_per_audio_token":3e-07,"input_cost_per_token":1e-07,"output_cost_per_reasoning_token":4e-07,"output_cost_per_token":4e-07}'::jsonb),
('gemini','gemini-2.5-flash-lite-preview-06-17','{"cache_read_input_token_cost":2.5e-08,"input_cost_per_audio_token":5e-07,"input_cost_per_token":1e-07,"output_cost_per_reasoning_token":4e-07,"output_cost_per_token":4e-07}'::jsonb),
('gemini','gemini-2.5-flash-lite-preview-09-2025','{"cache_read_input_token_cost":1e-08,"input_cost_per_audio_token":3e-07,"input_cost_per_token":1e-07,"output_cost_per_reasoning_token":4e-07,"output_cost_per_token":4e-07}'::jsonb),
('gemini','gemini-2.5-flash-native-audio-latest','{"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-2.5-flash-native-audio-preview-09-2025','{"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-2.5-flash-native-audio-preview-12-2025','{"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-2.5-flash-preview-09-2025','{"cache_read_input_token_cost":7.5e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_reasoning_token":2.5e-06,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-2.5-pro','{"cache_creation_input_token_cost":1.25e-06,"cache_creation_input_token_cost_above_200k_tokens":2.5e-06,"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_above_200k_tokens":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_above_200k_tokens":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_above_200k_tokens":1.5e-05}'::jsonb),
('gemini','gemini-2.5-pro-preview-tts','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_above_200k_tokens":2.5e-07,"input_cost_per_audio_token":7e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_above_200k_tokens":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_above_200k_tokens":1.5e-05}'::jsonb),
('gemini','gemini-3-flash','{"cache_read_input_token_cost":5e-08,"cache_read_input_token_cost_priority":9e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_audio_token_priority":1.8e-06,"input_cost_per_token":5e-07,"input_cost_per_token_priority":9e-07,"output_cost_per_reasoning_token":3e-06,"output_cost_per_token":3e-06,"output_cost_per_token_priority":5.4e-06}'::jsonb),
('gemini','gemini-3-flash-preview','{"cache_read_input_token_cost":5e-08,"cache_read_input_token_cost_priority":9e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_audio_token_priority":1.8e-06,"input_cost_per_token":5e-07,"input_cost_per_token_priority":9e-07,"output_cost_per_reasoning_token":3e-06,"output_cost_per_token":3e-06,"output_cost_per_token_priority":5.4e-06}'::jsonb),
('gemini','gemini-3-pro-preview','{"cache_creation_input_token_cost":2e-06,"cache_creation_input_token_cost_above_200k_tokens":4e-06,"cache_creation_input_token_cost_above_200k_tokens_priority":7.2e-06,"cache_creation_input_token_cost_priority":3.6e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_above_200k_tokens":4e-07,"cache_read_input_token_cost_above_200k_tokens_priority":7.2e-07,"cache_read_input_token_cost_priority":3.6e-07,"input_cost_per_token":2e-06,"input_cost_per_token_above_200k_tokens":4e-06,"input_cost_per_token_above_200k_tokens_priority":7.2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_priority":3.6e-06,"output_cost_per_token":1.2e-05,"output_cost_per_token_above_200k_tokens":1.8e-05,"output_cost_per_token_above_200k_tokens_priority":3.24e-05,"output_cost_per_token_batches":6e-06,"output_cost_per_token_priority":2.16e-05}'::jsonb),
('gemini','gemini-3.1-flash-lite','{"cache_read_input_token_cost":2.5e-08,"cache_read_input_token_cost_batches":1.25e-08,"cache_read_input_token_cost_flex":1.25e-08,"cache_read_input_token_cost_per_audio_token":5e-08,"cache_read_input_token_cost_priority":4.5e-08,"input_cost_per_audio_token":5e-07,"input_cost_per_token":2.5e-07,"input_cost_per_token_batches":1.25e-07,"input_cost_per_token_flex":1.25e-07,"input_cost_per_token_priority":4.5e-07,"output_cost_per_reasoning_token":1.5e-06,"output_cost_per_token":1.5e-06,"output_cost_per_token_batches":7.5e-07,"output_cost_per_token_flex":7.5e-07,"output_cost_per_token_priority":2.7e-06}'::jsonb),
('gemini','gemini-3.1-flash-lite-preview','{"cache_read_input_token_cost":2.5e-08,"cache_read_input_token_cost_per_audio_token":5e-08,"input_cost_per_audio_token":5e-07,"input_cost_per_token":2.5e-07,"output_cost_per_reasoning_token":1.5e-06,"output_cost_per_token":1.5e-06}'::jsonb),
('gemini','gemini-3.1-flash-live-preview','{"input_cost_per_audio_token":3e-06,"input_cost_per_image_token":1e-06,"input_cost_per_token":7.5e-07,"input_cost_per_video_per_second":3.3333333333333335e-05,"output_cost_per_audio_token":1.2e-05,"output_cost_per_token":4.5e-06}'::jsonb),
('gemini','gemini-3.1-pro-high','{"cache_creation_input_token_cost":2e-06,"cache_creation_input_token_cost_above_200k_tokens":4e-06,"cache_creation_input_token_cost_above_200k_tokens_priority":7.2e-06,"cache_creation_input_token_cost_priority":3.6e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_above_200k_tokens":4e-07,"cache_read_input_token_cost_above_200k_tokens_priority":7.2e-07,"cache_read_input_token_cost_priority":3.6e-07,"input_cost_per_token":2e-06,"input_cost_per_token_above_200k_tokens":4e-06,"input_cost_per_token_above_200k_tokens_priority":7.2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_priority":3.6e-06,"output_cost_per_image":0.00012,"output_cost_per_token":1.2e-05,"output_cost_per_token_above_200k_tokens":1.8e-05,"output_cost_per_token_above_200k_tokens_priority":3.24e-05,"output_cost_per_token_batches":6e-06,"output_cost_per_token_priority":2.16e-05}'::jsonb),
('gemini','gemini-3.1-pro-low','{"cache_creation_input_token_cost":2e-06,"cache_creation_input_token_cost_above_200k_tokens":4e-06,"cache_creation_input_token_cost_above_200k_tokens_priority":7.2e-06,"cache_creation_input_token_cost_priority":3.6e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_above_200k_tokens":4e-07,"cache_read_input_token_cost_above_200k_tokens_priority":7.2e-07,"cache_read_input_token_cost_priority":3.6e-07,"input_cost_per_token":2e-06,"input_cost_per_token_above_200k_tokens":4e-06,"input_cost_per_token_above_200k_tokens_priority":7.2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_priority":3.6e-06,"output_cost_per_image":0.00012,"output_cost_per_token":1.2e-05,"output_cost_per_token_above_200k_tokens":1.8e-05,"output_cost_per_token_above_200k_tokens_priority":3.24e-05,"output_cost_per_token_batches":6e-06,"output_cost_per_token_priority":2.16e-05}'::jsonb),
('gemini','gemini-3.1-pro-preview','{"cache_creation_input_token_cost":2e-06,"cache_creation_input_token_cost_above_200k_tokens":4e-06,"cache_creation_input_token_cost_above_200k_tokens_priority":7.2e-06,"cache_creation_input_token_cost_priority":3.6e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_above_200k_tokens":4e-07,"cache_read_input_token_cost_above_200k_tokens_priority":7.2e-07,"cache_read_input_token_cost_priority":3.6e-07,"input_cost_per_token":2e-06,"input_cost_per_token_above_200k_tokens":4e-06,"input_cost_per_token_above_200k_tokens_priority":7.2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_priority":3.6e-06,"output_cost_per_image":0.00012,"output_cost_per_token":1.2e-05,"output_cost_per_token_above_200k_tokens":1.8e-05,"output_cost_per_token_above_200k_tokens_priority":3.24e-05,"output_cost_per_token_batches":6e-06,"output_cost_per_token_priority":2.16e-05}'::jsonb),
('gemini','gemini-3.1-pro-preview-customtools','{"cache_creation_input_token_cost":2e-06,"cache_creation_input_token_cost_above_200k_tokens":4e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_above_200k_tokens":4e-07,"input_cost_per_token":2e-06,"input_cost_per_token_above_200k_tokens":4e-06,"input_cost_per_token_batches":1e-06,"output_cost_per_image":0.00012,"output_cost_per_token":1.2e-05,"output_cost_per_token_above_200k_tokens":1.8e-05,"output_cost_per_token_batches":6e-06}'::jsonb),
('gemini','gemini-3.5-flash','{"cache_read_input_token_cost":1.5e-07,"cache_read_input_token_cost_priority":2.7e-07,"input_cost_per_audio_token":1e-06,"input_cost_per_audio_token_priority":1.8e-06,"input_cost_per_token":1.5e-06,"input_cost_per_token_priority":2.7e-06,"output_cost_per_reasoning_token":9e-06,"output_cost_per_token":9e-06,"output_cost_per_token_priority":1.62e-05}'::jsonb),
('gemini','gemini-3.6-flash','{"cache_read_input_token_cost":1.5e-07,"cache_read_input_token_cost_priority":2.7e-07,"input_cost_per_token":1.5e-06,"input_cost_per_token_priority":2.7e-06,"output_cost_per_token":7.5e-06,"output_cost_per_token_priority":1.35e-05}'::jsonb),
('gemini','gemini-exp-1206','{"cache_read_input_token_cost":3e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_reasoning_token":2.5e-06,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-flash-latest','{"cache_read_input_token_cost":3e-08,"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_reasoning_token":2.5e-06,"output_cost_per_token":2.5e-06}'::jsonb),
('gemini','gemini-flash-lite-latest','{"cache_read_input_token_cost":1e-08,"input_cost_per_audio_token":3e-07,"input_cost_per_token":1e-07,"output_cost_per_reasoning_token":4e-07,"output_cost_per_token":4e-07}'::jsonb),
('gemini','gemini-pro-latest','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_above_200k_tokens":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_above_200k_tokens":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_above_200k_tokens":1.5e-05}'::jsonb),
('gemini','gemini-robotics-er-1.5-preview','{"cache_read_input_token_cost":0,"input_cost_per_audio_token":1e-06,"input_cost_per_token":3e-07,"output_cost_per_reasoning_token":2.5e-06,"output_cost_per_token":2.5e-06}'::jsonb),
('openai','gpt-3.5-turbo','{"input_cost_per_token":5e-07,"output_cost_per_token":1.5e-06}'::jsonb),
('openai','gpt-3.5-turbo-0125','{"input_cost_per_token":5e-07,"output_cost_per_token":1.5e-06}'::jsonb),
('openai','gpt-3.5-turbo-1106','{"input_cost_per_token":1e-06,"output_cost_per_token":2e-06}'::jsonb),
('openai','gpt-3.5-turbo-16k','{"input_cost_per_token":3e-06,"output_cost_per_token":4e-06}'::jsonb),
('openai','gpt-4','{"input_cost_per_token":3e-05,"output_cost_per_token":6e-05}'::jsonb),
('openai','gpt-4-0125-preview','{"input_cost_per_token":1e-05,"output_cost_per_token":3e-05}'::jsonb),
('openai','gpt-4-0314','{"input_cost_per_token":3e-05,"output_cost_per_token":6e-05}'::jsonb),
('openai','gpt-4-0613','{"input_cost_per_token":3e-05,"output_cost_per_token":6e-05}'::jsonb),
('openai','gpt-4-1106-preview','{"input_cost_per_token":1e-05,"output_cost_per_token":3e-05}'::jsonb),
('openai','gpt-4-turbo','{"input_cost_per_token":1e-05,"output_cost_per_token":3e-05}'::jsonb),
('openai','gpt-4-turbo-2024-04-09','{"input_cost_per_token":1e-05,"output_cost_per_token":3e-05}'::jsonb),
('openai','gpt-4-turbo-preview','{"input_cost_per_token":1e-05,"output_cost_per_token":3e-05}'::jsonb),
('openai','gpt-4.1','{"cache_read_input_token_cost":5e-07,"cache_read_input_token_cost_priority":8.75e-07,"input_cost_per_token":2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":8e-06,"output_cost_per_token_batches":4e-06,"output_cost_per_token_priority":1.4e-05}'::jsonb),
('openai','gpt-4.1-2025-04-14','{"cache_read_input_token_cost":5e-07,"input_cost_per_token":2e-06,"input_cost_per_token_batches":1e-06,"output_cost_per_token":8e-06,"output_cost_per_token_batches":4e-06}'::jsonb),
('openai','gpt-4.1-mini','{"cache_read_input_token_cost":1e-07,"cache_read_input_token_cost_priority":1.75e-07,"input_cost_per_token":4e-07,"input_cost_per_token_batches":2e-07,"input_cost_per_token_priority":7e-07,"output_cost_per_token":1.6e-06,"output_cost_per_token_batches":8e-07,"output_cost_per_token_priority":2.8e-06}'::jsonb),
('openai','gpt-4.1-mini-2025-04-14','{"cache_read_input_token_cost":1e-07,"input_cost_per_token":4e-07,"input_cost_per_token_batches":2e-07,"output_cost_per_token":1.6e-06,"output_cost_per_token_batches":8e-07}'::jsonb),
('openai','gpt-4.1-nano','{"cache_read_input_token_cost":2.5e-08,"cache_read_input_token_cost_priority":5e-08,"input_cost_per_token":1e-07,"input_cost_per_token_batches":5e-08,"input_cost_per_token_priority":2e-07,"output_cost_per_token":4e-07,"output_cost_per_token_batches":2e-07,"output_cost_per_token_priority":8e-07}'::jsonb),
('openai','gpt-4.1-nano-2025-04-14','{"cache_read_input_token_cost":2.5e-08,"input_cost_per_token":1e-07,"input_cost_per_token_batches":5e-08,"output_cost_per_token":4e-07,"output_cost_per_token_batches":2e-07}'::jsonb),
('openai','gpt-4o','{"cache_read_input_token_cost":1.25e-06,"cache_read_input_token_cost_priority":2.125e-06,"input_cost_per_token":2.5e-06,"input_cost_per_token_batches":1.25e-06,"input_cost_per_token_priority":4.25e-06,"output_cost_per_token":1e-05,"output_cost_per_token_batches":5e-06,"output_cost_per_token_priority":1.7e-05}'::jsonb),
('openai','gpt-4o-2024-05-13','{"input_cost_per_token":5e-06,"input_cost_per_token_batches":2.5e-06,"input_cost_per_token_priority":8.75e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_batches":7.5e-06,"output_cost_per_token_priority":2.625e-05}'::jsonb),
('openai','gpt-4o-2024-08-06','{"cache_read_input_token_cost":1.25e-06,"input_cost_per_token":2.5e-06,"input_cost_per_token_batches":1.25e-06,"output_cost_per_token":1e-05,"output_cost_per_token_batches":5e-06}'::jsonb),
('openai','gpt-4o-2024-11-20','{"cache_read_input_token_cost":1.25e-06,"input_cost_per_token":2.5e-06,"input_cost_per_token_batches":1.25e-06,"output_cost_per_token":1e-05,"output_cost_per_token_batches":5e-06}'::jsonb),
('openai','gpt-4o-audio-preview','{"input_cost_per_audio_token":4e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-4o-audio-preview-2024-12-17','{"input_cost_per_audio_token":4e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-4o-audio-preview-2025-06-03','{"input_cost_per_audio_token":4e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-4o-mini','{"cache_read_input_token_cost":7.5e-08,"cache_read_input_token_cost_priority":1.25e-07,"input_cost_per_token":1.5e-07,"input_cost_per_token_batches":7.5e-08,"input_cost_per_token_priority":2.5e-07,"output_cost_per_token":6e-07,"output_cost_per_token_batches":3e-07,"output_cost_per_token_priority":1e-06}'::jsonb),
('openai','gpt-4o-mini-2024-07-18','{"cache_read_input_token_cost":7.5e-08,"input_cost_per_token":1.5e-07,"input_cost_per_token_batches":7.5e-08,"output_cost_per_token":6e-07,"output_cost_per_token_batches":3e-07}'::jsonb),
('openai','gpt-4o-mini-audio-preview','{"input_cost_per_audio_token":1e-05,"input_cost_per_token":1.5e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":6e-07}'::jsonb),
('openai','gpt-4o-mini-audio-preview-2024-12-17','{"input_cost_per_audio_token":1e-05,"input_cost_per_token":1.5e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":6e-07}'::jsonb),
('openai','gpt-4o-mini-realtime-preview','{"cache_creation_input_audio_token_cost":3e-07,"cache_read_input_token_cost":3e-07,"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-4o-mini-realtime-preview-2024-12-17','{"cache_creation_input_audio_token_cost":3e-07,"cache_read_input_token_cost":3e-07,"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-4o-mini-search-preview','{"cache_read_input_token_cost":7.5e-08,"input_cost_per_token":1.5e-07,"input_cost_per_token_batches":7.5e-08,"output_cost_per_token":6e-07,"output_cost_per_token_batches":3e-07}'::jsonb),
('openai','gpt-4o-mini-search-preview-2025-03-11','{"cache_read_input_token_cost":7.5e-08,"input_cost_per_token":1.5e-07,"input_cost_per_token_batches":7.5e-08,"output_cost_per_token":6e-07,"output_cost_per_token_batches":3e-07}'::jsonb),
('openai','gpt-4o-realtime-preview','{"cache_read_input_token_cost":2.5e-06,"input_cost_per_audio_token":4e-05,"input_cost_per_token":5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":2e-05}'::jsonb),
('openai','gpt-4o-realtime-preview-2024-12-17','{"cache_read_input_token_cost":2.5e-06,"input_cost_per_audio_token":4e-05,"input_cost_per_token":5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":2e-05}'::jsonb),
('openai','gpt-4o-realtime-preview-2025-06-03','{"cache_read_input_token_cost":2.5e-06,"input_cost_per_audio_token":4e-05,"input_cost_per_token":5e-06,"output_cost_per_audio_token":8e-05,"output_cost_per_token":2e-05}'::jsonb),
('openai','gpt-4o-search-preview','{"cache_read_input_token_cost":1.25e-06,"input_cost_per_token":2.5e-06,"input_cost_per_token_batches":1.25e-06,"output_cost_per_token":1e-05,"output_cost_per_token_batches":5e-06}'::jsonb),
('openai','gpt-4o-search-preview-2025-03-11','{"cache_read_input_token_cost":1.25e-06,"input_cost_per_token":2.5e-06,"input_cost_per_token_batches":1.25e-06,"output_cost_per_token":1e-05,"output_cost_per_token_batches":5e-06}'::jsonb),
('openai','gpt-5','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_flex":6.25e-08,"cache_read_input_token_cost_priority":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_flex":6.25e-07,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_flex":5e-06,"output_cost_per_token_priority":2e-05}'::jsonb),
('openai','gpt-5-2025-08-07','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_flex":6.25e-08,"cache_read_input_token_cost_priority":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_flex":6.25e-07,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_flex":5e-06,"output_cost_per_token_priority":2e-05}'::jsonb),
('openai','gpt-5-chat','{"cache_read_input_token_cost":1.25e-07,"input_cost_per_token":1.25e-06,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-5-chat-latest','{"cache_read_input_token_cost":1.25e-07,"input_cost_per_token":1.25e-06,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-5-mini','{"cache_read_input_token_cost":2.5e-08,"cache_read_input_token_cost_flex":1.25e-08,"cache_read_input_token_cost_priority":4.5e-08,"input_cost_per_token":2.5e-07,"input_cost_per_token_flex":1.25e-07,"input_cost_per_token_priority":4.5e-07,"output_cost_per_token":2e-06,"output_cost_per_token_flex":1e-06,"output_cost_per_token_priority":3.6e-06}'::jsonb),
('openai','gpt-5-mini-2025-08-07','{"cache_read_input_token_cost":2.5e-08,"cache_read_input_token_cost_flex":1.25e-08,"cache_read_input_token_cost_priority":4.5e-08,"input_cost_per_token":2.5e-07,"input_cost_per_token_flex":1.25e-07,"input_cost_per_token_priority":4.5e-07,"output_cost_per_token":2e-06,"output_cost_per_token_flex":1e-06,"output_cost_per_token_priority":3.6e-06}'::jsonb),
('openai','gpt-5-nano','{"cache_read_input_token_cost":5e-09,"cache_read_input_token_cost_flex":2.5e-09,"input_cost_per_token":5e-08,"input_cost_per_token_flex":2.5e-08,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":4e-07,"output_cost_per_token_flex":2e-07}'::jsonb),
('openai','gpt-5-nano-2025-08-07','{"cache_read_input_token_cost":5e-09,"cache_read_input_token_cost_flex":2.5e-09,"input_cost_per_token":5e-08,"input_cost_per_token_flex":2.5e-08,"output_cost_per_token":4e-07,"output_cost_per_token_flex":2e-07}'::jsonb),
('openai','gpt-5-search-api','{"cache_read_input_token_cost":1.25e-07,"input_cost_per_token":1.25e-06,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-5-search-api-2025-10-14','{"cache_read_input_token_cost":1.25e-07,"input_cost_per_token":1.25e-06,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-5.1','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_priority":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_priority":2e-05}'::jsonb),
('openai','gpt-5.1-2025-11-13','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_priority":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_priority":2e-05}'::jsonb),
('openai','gpt-5.1-chat-latest','{"cache_read_input_token_cost":1.25e-07,"cache_read_input_token_cost_priority":2.5e-07,"input_cost_per_token":1.25e-06,"input_cost_per_token_priority":2.5e-06,"output_cost_per_token":1e-05,"output_cost_per_token_priority":2e-05}'::jsonb),
('openai','gpt-5.2','{"cache_read_input_token_cost":1.75e-07,"cache_read_input_token_cost_priority":3.5e-07,"input_cost_per_token":1.75e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":1.4e-05,"output_cost_per_token_priority":2.8e-05}'::jsonb),
('openai','gpt-5.2-2025-12-11','{"cache_read_input_token_cost":1.75e-07,"cache_read_input_token_cost_priority":3.5e-07,"input_cost_per_token":1.75e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":1.4e-05,"output_cost_per_token_priority":2.8e-05}'::jsonb),
('openai','gpt-5.2-chat-latest','{"cache_read_input_token_cost":1.75e-07,"cache_read_input_token_cost_priority":3.5e-07,"input_cost_per_token":1.75e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":1.4e-05,"output_cost_per_token_priority":2.8e-05}'::jsonb),
('openai','gpt-5.3-chat-latest','{"cache_read_input_token_cost":1.75e-07,"cache_read_input_token_cost_priority":3.5e-07,"input_cost_per_token":1.75e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":1.4e-05,"output_cost_per_token_priority":2.8e-05}'::jsonb),
('openai','gpt-5.4','{"cache_read_input_token_cost":2.5e-07,"cache_read_input_token_cost_above_272k_tokens":5e-07,"cache_read_input_token_cost_flex":1.3e-07,"cache_read_input_token_cost_priority":5e-07,"input_cost_per_token":2.5e-06,"input_cost_per_token_above_272k_tokens":5e-06,"input_cost_per_token_batches":1.25e-06,"input_cost_per_token_flex":1.25e-06,"input_cost_per_token_priority":5e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_272k_tokens":2.25e-05,"output_cost_per_token_batches":7.5e-06,"output_cost_per_token_flex":7.5e-06,"output_cost_per_token_priority":3e-05}'::jsonb),
('openai','gpt-5.4-2026-03-05','{"cache_read_input_token_cost":2.5e-07,"cache_read_input_token_cost_above_272k_tokens":5e-07,"cache_read_input_token_cost_flex":1.3e-07,"cache_read_input_token_cost_priority":5e-07,"input_cost_per_token":2.5e-06,"input_cost_per_token_above_272k_tokens":5e-06,"input_cost_per_token_batches":1.25e-06,"input_cost_per_token_flex":1.25e-06,"input_cost_per_token_priority":5e-06,"output_cost_per_token":1.5e-05,"output_cost_per_token_above_272k_tokens":2.25e-05,"output_cost_per_token_batches":7.5e-06,"output_cost_per_token_flex":7.5e-06,"output_cost_per_token_priority":3e-05}'::jsonb),
('openai','gpt-5.4-mini','{"cache_read_input_token_cost":7.5e-08,"cache_read_input_token_cost_batches":3.75e-08,"cache_read_input_token_cost_flex":3.75e-08,"cache_read_input_token_cost_priority":1.5e-07,"input_cost_per_token":7.5e-07,"input_cost_per_token_batches":3.75e-07,"input_cost_per_token_flex":3.75e-07,"input_cost_per_token_priority":1.5e-06,"output_cost_per_token":4.5e-06,"output_cost_per_token_batches":2.25e-06,"output_cost_per_token_flex":2.25e-06,"output_cost_per_token_priority":9e-06}'::jsonb),
('openai','gpt-5.4-mini-2026-03-17','{"cache_read_input_token_cost":7.5e-08,"cache_read_input_token_cost_batches":3.75e-08,"cache_read_input_token_cost_flex":3.75e-08,"cache_read_input_token_cost_priority":1.5e-07,"input_cost_per_token":7.5e-07,"input_cost_per_token_batches":3.75e-07,"input_cost_per_token_flex":3.75e-07,"input_cost_per_token_priority":1.5e-06,"output_cost_per_token":4.5e-06,"output_cost_per_token_batches":2.25e-06,"output_cost_per_token_flex":2.25e-06,"output_cost_per_token_priority":9e-06}'::jsonb),
('openai','gpt-5.4-nano','{"cache_read_input_token_cost":2e-08,"cache_read_input_token_cost_batches":1e-08,"cache_read_input_token_cost_flex":1e-08,"input_cost_per_token":2e-07,"input_cost_per_token_batches":1e-07,"input_cost_per_token_flex":1e-07,"output_cost_per_token":1.25e-06,"output_cost_per_token_batches":6.25e-07,"output_cost_per_token_flex":6.25e-07}'::jsonb),
('openai','gpt-5.4-nano-2026-03-17','{"cache_read_input_token_cost":2e-08,"cache_read_input_token_cost_batches":1e-08,"cache_read_input_token_cost_flex":1e-08,"input_cost_per_token":2e-07,"input_cost_per_token_batches":1e-07,"input_cost_per_token_flex":1e-07,"output_cost_per_token":1.25e-06,"output_cost_per_token_batches":6.25e-07,"output_cost_per_token_flex":6.25e-07}'::jsonb),
('openai','gpt-5.6-sol','{"cache_creation_input_token_cost":6.25e-06,"cache_creation_input_token_cost_batches":3.125e-06,"cache_creation_input_token_cost_flex":3.125e-06,"cache_creation_input_token_cost_priority":1.25e-05,"cache_read_input_token_cost":5e-07,"cache_read_input_token_cost_flex":2.5e-07,"cache_read_input_token_cost_priority":1e-06,"input_cost_per_token":5e-06,"input_cost_per_token_batches":2.5e-06,"input_cost_per_token_flex":2.5e-06,"input_cost_per_token_priority":1e-05,"long_context_input_cost_multiplier":2.0,"long_context_output_cost_multiplier":1.5,"output_cost_per_token":3e-05,"output_cost_per_token_batches":1.5e-05,"output_cost_per_token_flex":1.5e-05,"output_cost_per_token_priority":6e-05}'::jsonb),
('openai','gpt-5.6-terra','{"cache_creation_input_token_cost":2.5e-06,"cache_creation_input_token_cost_batches":1.25e-06,"cache_creation_input_token_cost_flex":1.25e-06,"cache_creation_input_token_cost_priority":5e-06,"cache_read_input_token_cost":2e-07,"cache_read_input_token_cost_flex":1e-07,"cache_read_input_token_cost_priority":4e-07,"input_cost_per_token":2e-06,"input_cost_per_token_batches":1e-06,"input_cost_per_token_flex":1e-06,"input_cost_per_token_priority":4e-06,"long_context_input_cost_multiplier":2.0,"long_context_output_cost_multiplier":1.5,"output_cost_per_token":1.2e-05,"output_cost_per_token_batches":6e-06,"output_cost_per_token_flex":6e-06,"output_cost_per_token_priority":2.4e-05}'::jsonb),
('openai','gpt-5.6-luna','{"cache_creation_input_token_cost":2.5e-07,"cache_creation_input_token_cost_batches":1.25e-07,"cache_creation_input_token_cost_flex":1.25e-07,"cache_creation_input_token_cost_priority":5e-07,"cache_read_input_token_cost":2e-08,"cache_read_input_token_cost_flex":1e-08,"cache_read_input_token_cost_priority":4e-08,"input_cost_per_token":2e-07,"input_cost_per_token_batches":1e-07,"input_cost_per_token_flex":1e-07,"input_cost_per_token_priority":4e-07,"long_context_input_cost_multiplier":2.0,"long_context_output_cost_multiplier":1.5,"output_cost_per_token":1.2e-06,"output_cost_per_token_batches":6e-07,"output_cost_per_token_flex":6e-07,"output_cost_per_token_priority":2.4e-06}'::jsonb),
('openai','gpt-5.5','{"cache_read_input_token_cost":5e-07,"cache_read_input_token_cost_above_272k_tokens":1e-06,"cache_read_input_token_cost_flex":2.5e-07,"cache_read_input_token_cost_priority":1.25e-06,"input_cost_per_token":5e-06,"input_cost_per_token_above_272k_tokens":1e-05,"input_cost_per_token_batches":2.5e-06,"input_cost_per_token_flex":2.5e-06,"input_cost_per_token_priority":1.25e-05,"output_cost_per_token":3e-05,"output_cost_per_token_above_272k_tokens":4.5e-05,"output_cost_per_token_batches":1.5e-05,"output_cost_per_token_flex":1.5e-05,"output_cost_per_token_priority":7.5e-05}'::jsonb),
('openai','gpt-5.5-2026-04-23','{"cache_read_input_token_cost":5e-07,"cache_read_input_token_cost_above_272k_tokens":1e-06,"cache_read_input_token_cost_flex":2.5e-07,"cache_read_input_token_cost_priority":1.25e-06,"input_cost_per_token":5e-06,"input_cost_per_token_above_272k_tokens":1e-05,"input_cost_per_token_batches":2.5e-06,"input_cost_per_token_flex":2.5e-06,"input_cost_per_token_priority":1.25e-05,"output_cost_per_token":3e-05,"output_cost_per_token_above_272k_tokens":4.5e-05,"output_cost_per_token_batches":1.5e-05,"output_cost_per_token_flex":1.5e-05,"output_cost_per_token_priority":7.5e-05}'::jsonb),
('openai','gpt-audio','{"input_cost_per_audio_token":3.2e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-audio-1.5','{"input_cost_per_audio_token":3.2e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-audio-2025-08-28','{"input_cost_per_audio_token":3.2e-05,"input_cost_per_token":2.5e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1e-05}'::jsonb),
('openai','gpt-audio-mini','{"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-audio-mini-2025-10-06','{"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-audio-mini-2025-12-15','{"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-realtime','{"cache_creation_input_audio_token_cost":4e-07,"cache_read_input_token_cost":4e-07,"input_cost_per_audio_token":3.2e-05,"input_cost_per_image":5e-06,"input_cost_per_token":4e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1.6e-05}'::jsonb),
('openai','gpt-realtime-1.5','{"cache_creation_input_audio_token_cost":4e-07,"cache_read_input_token_cost":4e-07,"input_cost_per_audio_token":3.2e-05,"input_cost_per_image":5e-06,"input_cost_per_token":4e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1.6e-05}'::jsonb),
('openai','gpt-realtime-2','{"cache_creation_input_audio_token_cost":4e-07,"cache_read_input_token_cost":4e-07,"input_cost_per_audio_token":3.2e-05,"input_cost_per_image":5e-06,"input_cost_per_token":4e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1.6e-05}'::jsonb),
('openai','gpt-realtime-2025-08-28','{"cache_creation_input_audio_token_cost":4e-07,"cache_read_input_token_cost":4e-07,"input_cost_per_audio_token":3.2e-05,"input_cost_per_image":5e-06,"input_cost_per_token":4e-06,"output_cost_per_audio_token":6.4e-05,"output_cost_per_token":1.6e-05}'::jsonb),
('openai','gpt-realtime-mini','{"cache_creation_input_audio_token_cost":3e-07,"cache_read_input_audio_token_cost":3e-07,"input_cost_per_audio_token":1e-05,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-realtime-mini-2025-10-06','{"cache_creation_input_audio_token_cost":3e-07,"cache_read_input_audio_token_cost":3e-07,"cache_read_input_token_cost":6e-08,"input_cost_per_audio_token":1e-05,"input_cost_per_image":8e-07,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','gpt-realtime-mini-2025-12-15','{"cache_creation_input_audio_token_cost":3e-07,"cache_read_input_audio_token_cost":3e-07,"cache_read_input_token_cost":6e-08,"input_cost_per_audio_token":1e-05,"input_cost_per_image":8e-07,"input_cost_per_token":6e-07,"output_cost_per_audio_token":2e-05,"output_cost_per_token":2.4e-06}'::jsonb),
('openai','o1-2024-12-17','{"cache_read_input_token_cost":7.5e-06,"input_cost_per_token":1.5e-05,"output_cost_per_token":6e-05}'::jsonb),
('openai','o3','{"cache_read_input_token_cost":5e-07,"cache_read_input_token_cost_flex":2.5e-07,"cache_read_input_token_cost_priority":8.75e-07,"input_cost_per_token":2e-06,"input_cost_per_token_flex":1e-06,"input_cost_per_token_priority":3.5e-06,"output_cost_per_token":8e-06,"output_cost_per_token_flex":4e-06,"output_cost_per_token_priority":1.4e-05}'::jsonb),
('openai','o3-2025-04-16','{"cache_read_input_token_cost":5e-07,"input_cost_per_token":2e-06,"output_cost_per_token":8e-06}'::jsonb),
('openai','o3-mini','{"cache_read_input_token_cost":5.5e-07,"input_cost_per_token":1.1e-06,"output_cost_per_token":4.4e-06}'::jsonb),
('openai','o3-mini-2025-01-31','{"cache_read_input_token_cost":5.5e-07,"input_cost_per_token":1.1e-06,"output_cost_per_token":4.4e-06}'::jsonb),
('openai','o4-mini','{"cache_read_input_token_cost":2.75e-07,"cache_read_input_token_cost_flex":1.375e-07,"cache_read_input_token_cost_priority":5e-07,"input_cost_per_token":1.1e-06,"input_cost_per_token_flex":5.5e-07,"input_cost_per_token_priority":2e-06,"output_cost_per_token":4.4e-06,"output_cost_per_token_flex":2.2e-06,"output_cost_per_token_priority":8e-06}'::jsonb),
('openai','o4-mini-2025-04-16','{"cache_read_input_token_cost":2.75e-07,"input_cost_per_token":1.1e-06,"output_cost_per_token":4.4e-06}'::jsonb);

alter table public.s2a_groups add column rate_multiplier numeric(12,6) not null default 1 check(rate_multiplier between 0 and 1000000);
alter table public.s2a_keys
 add column monetary_quota numeric(20,8) check(monetary_quota>=0),
 add column monetary_used numeric(20,8) not null default 0 check(monetary_used>=0);
alter table public.s2a_leases add column billing jsonb not null default '{}';
alter table public.s2a_usage
 add column group_id uuid references public.s2a_groups(id),
 add column input_cost numeric(20,12),
 add column output_cost numeric(20,12),
 add column cache_creation_cost numeric(20,12),
 add column cache_read_cost numeric(20,12),
 add column total_cost numeric(20,12),
 add column actual_cost numeric(20,8),
 add column rate_multiplier numeric(12,6),
 add column billing_mode text not null default 'token',
 add column service_tier text,
 add column stream boolean,
 add column billing_status text not null default 'unknown' check(billing_status in ('unknown','settled','free'));
-- Provider usage must still be charged when its final cost exceeds the remaining credit.
alter table public.s2a_wallets drop constraint s2a_wallets_balance_check;
alter table public.s2a_wallet_ledger drop constraint s2a_wallet_ledger_balance_after_check;

create function public.s2a_price_rate(p_rates jsonb,p_field text,p_context bigint,p_tier text default null)
returns numeric language plpgsql immutable set search_path='' as $$
declare base numeric; rate numeric; threshold bigint; chosen bigint:=0; entry record; suffix text;
begin
 base := coalesce((p_rates->>p_field)::numeric,0);
 rate := base;
 for entry in select key,value from jsonb_each_text(p_rates) loop
  if entry.key ~ ('^'||p_field||'_above_[0-9]+k_tokens$') then
   threshold := (substring(entry.key from '_above_([0-9]+)k_tokens$'))::bigint*1000;
   if p_context>threshold and threshold>chosen then chosen:=threshold; rate:=entry.value::numeric; end if;
  end if;
 end loop;
 if p_tier in ('fast','priority') then suffix:='priority';
 elsif p_tier='flex' then suffix:='flex';
 elsif p_tier='ultrafast' then return rate*2;
 else return rate; end if;
 if chosen>0 and p_rates ? (p_field||'_above_'||(chosen/1000)::text||'k_tokens_'||suffix) then
  return (p_rates->>(p_field||'_above_'||(chosen/1000)::text||'k_tokens_'||suffix))::numeric;
 end if;
 if p_rates ? (p_field||'_'||suffix) then
  if base>0 then return rate*(p_rates->>(p_field||'_'||suffix))::numeric/base; end if;
  return (p_rates->>(p_field||'_'||suffix))::numeric;
 end if;
 return rate*case suffix when 'priority' then 2 else 0.5 end;
end $$;

create function public.s2a_price_lookup(p_platform text,p_model text)
returns jsonb language sql stable set search_path='' as $$
 select rates from public.s2a_model_prices
 where (p_platform is null or platform=p_platform) and (lower(model)=lower(p_model)
  or lower(model)=lower(regexp_replace(p_model,'-[0-9]{8}$','')))
 order by (lower(model)=lower(p_model)) desc limit 1;
$$;

create function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text,p_billing_context jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys; g public.s2a_groups; w public.s2a_wallets; prices jsonb; result jsonb;
begin
 if p_billing_context is null or jsonb_typeof(p_billing_context)<>'object' then return jsonb_build_object('error','invalid_billing_context','status',400); end if;
 select * into k from public.s2a_keys where key_hash=p_key_hash;
 if not found or k.revoked or k.expires_at<=now() or not exists(select 1 from auth.users where id=k.user_id and (banned_until is null or banned_until<=now())) then
  return jsonb_build_object('error','invalid_api_key','status',401);
 end if;
 insert into public.s2a_user_limits(user_id) values(k.user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where key_hash=p_key_hash for update;
 if not found or k.revoked or k.expires_at<=now() then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 select * into g from public.s2a_groups where id=k.group_id and enabled;
 if not found or not exists(select 1 from public.s2a_memberships where user_id=k.user_id and group_id=k.group_id) then
  return jsonb_build_object('error','group_access_denied','status',403);
 end if;
 begin
 if cardinality(k.ip_blacklist)>0 and p_client_ip is not null and exists(select 1 from unnest(k.ip_blacklist) rule where p_client_ip::inet <<= rule::cidr) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 if cardinality(k.ip_whitelist)>0 and (p_client_ip is null or not exists(select 1 from unnest(k.ip_whitelist) rule where p_client_ip::inet <<= rule::cidr)) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 exception when invalid_text_representation then return jsonb_build_object('error','ip_restricted','status',403);
 end;
 if p_model<>'__models__' then
  prices := public.s2a_price_lookup(g.platform,p_model);
  if prices is null then return jsonb_build_object('error','model_pricing_unavailable','status',422); end if;
  if k.monetary_quota is not null and k.monetary_used>=k.monetary_quota then
   return jsonb_build_object('error','monetary_quota_exceeded','status',429);
  end if;
  if g.rate_multiplier>0 and exists(select 1 from jsonb_each_text(prices) rate where rate.value::numeric>0) then
   insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
   select * into w from public.s2a_wallets where user_id=k.user_id for update;
   if w.balance<=w.frozen_balance then return jsonb_build_object('error','insufficient_balance','status',402); end if;
  end if;
 end if;
 result := public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request,p_client_ip);
 if result ? 'lease_id' then
  update public.s2a_leases set billing=jsonb_build_object('rates',prices,'platform',g.platform,
   'group_id',g.id,'rate_multiplier',g.rate_multiplier,'service_tier',p_billing_context->>'service_tier',
   'stream',coalesce((p_billing_context->>case when result->'account'->>'type'='apikey' then 'native_stream' else 'stream' end)::boolean,false)) where id=(result->>'lease_id')::uuid;
 end if;
 return result;
end $$;

create or replace function public.s2a_finish(
 p_lease_id uuid,p_status integer,p_outcome text,
 p_input_tokens bigint default null,p_output_tokens bigint default null,
 p_cache_creation_tokens bigint default null,p_cache_read_tokens bigint default null,
 p_cooldown_seconds integer default 0)
returns void language plpgsql set search_path='' as $$
declare l public.s2a_leases; k public.s2a_keys; prices jsonb; tier text; context bigint; billable_input bigint;
 input_price numeric; output_price numeric; creation_price numeric; read_price numeric;
 total numeric; charged numeric(20,8); multiplier numeric; next_balance numeric; state text:='unknown';
begin
 select * into l from public.s2a_leases where id=p_lease_id;
 if not found then return; end if;
 select * into k from public.s2a_keys where id=l.key_id;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where id=l.key_id for update;
 select * into l from public.s2a_leases where id=p_lease_id for update;
 if not found then return; end if;
 prices := l.billing->'rates';
 tier := l.billing->>'service_tier';
 multiplier := coalesce((l.billing->>'rate_multiplier')::numeric,1);
 if p_input_tokens is not null and p_output_tokens is not null and jsonb_typeof(prices)='object' then
  billable_input := greatest(0,p_input_tokens-case when l.billing->>'platform'='anthropic' then 0 else coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0) end);
  context := billable_input+coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0);
  input_price := billable_input*public.s2a_price_rate(prices,'input_cost_per_token',context,tier);
  output_price := p_output_tokens*public.s2a_price_rate(prices,'output_cost_per_token',context,tier);
  creation_price := coalesce(p_cache_creation_tokens,0)*public.s2a_price_rate(prices,'cache_creation_input_token_cost',context,tier);
  read_price := coalesce(p_cache_read_tokens,0)*public.s2a_price_rate(prices,'cache_read_input_token_cost',context,tier);
  total := input_price+output_price+creation_price+read_price;
  charged := round(total*multiplier,8);
  state := case when charged>0 then 'settled' else 'free' end;
 end if;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,model,status,outcome,input_tokens,output_tokens,
  cache_creation_tokens,cache_read_tokens,duration_ms,group_id,input_cost,output_cost,cache_creation_cost,cache_read_cost,
  total_cost,actual_cost,rate_multiplier,service_tier,stream,billing_status)
 values(l.id,l.request_id,l.account_id,l.key_id,k.user_id,l.model,p_status,p_outcome,p_input_tokens,p_output_tokens,
  p_cache_creation_tokens,p_cache_read_tokens,greatest(0,floor(extract(epoch from(clock_timestamp()-l.started_at))*1000)::integer),
  coalesce((l.billing->>'group_id')::uuid,k.group_id),input_price,output_price,creation_price,read_price,total,charged,
  multiplier,tier,(l.billing->>'stream')::boolean,state);
 update public.s2a_keys set quota_used=quota_used+coalesce(p_input_tokens,0)+coalesce(p_output_tokens,0),
  monetary_used=monetary_used+coalesce(charged,0) where id=k.id;
 if charged>0 then
  insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
  update public.s2a_wallets set balance=balance-charged,updated_at=now() where user_id=k.user_id returning balance into next_balance;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes)
   values(k.user_id,-charged,next_balance,'usage',l.id::text);
 end if;
 if p_cooldown_seconds>0 then update public.s2a_accounts set cooldown_until=greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>least(p_cooldown_seconds,3600))) where id=l.account_id; end if;
 delete from public.s2a_leases where id=l.id;
end $$;
revoke all on function public.s2a_price_rate(jsonb,text,bigint,text) from public,anon,authenticated;
revoke all on function public.s2a_price_lookup(text,text) from public,anon,authenticated;
revoke all on function public.s2a_acquire(text,text,uuid,uuid[],boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_price_rate(jsonb,text,bigint,text) to service_role;
grant execute on function public.s2a_price_lookup(text,text) to service_role;
grant execute on function public.s2a_acquire(text,text,uuid,uuid[],boolean,text,jsonb) to service_role;

create or replace function public.s2a_wallet_update(p_user_id uuid, p_amount numeric, p_operation text,
 p_notes text default '', p_actor_id uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare w public.s2a_wallets; next_balance numeric(20,8); change numeric(20,8);
begin
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount < 0
  or p_amount > 1000000000 or p_amount <> round(p_amount,8)
  or p_operation is null or p_operation not in ('set','add','subtract') then
  return jsonb_build_object('error','invalid_balance','status',400);
 end if;
 if not exists(select 1 from auth.users where id=p_user_id) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 insert into public.s2a_wallets(user_id) values(p_user_id) on conflict do nothing;
 select * into w from public.s2a_wallets where user_id=p_user_id for update;
 next_balance := case p_operation when 'set' then p_amount when 'add' then w.balance+p_amount else w.balance-p_amount end;
 if next_balance < w.frozen_balance and next_balance < w.balance then
  return jsonb_build_object('error','insufficient_balance','status',409);
 end if;
 change := next_balance-w.balance;
 if change <> 0 then
  update public.s2a_wallets set balance=next_balance, updated_at=now() where user_id=p_user_id;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes,actor_id)
   values(p_user_id,change,next_balance,'admin_'||p_operation,coalesce(p_notes,''),p_actor_id);
 end if;
 return jsonb_build_object('balance',next_balance,'frozen_balance',w.frozen_balance);
end $$;


create or replace function public.s2a_dashboard(
  p_user_id uuid, p_start timestamptz, p_end timestamptz,
  p_timezone text default 'Asia/Shanghai', p_key_id uuid default null,
  p_model text default null, p_granularity text default 'day',
  p_include_series boolean default true
) returns jsonb language sql stable set search_path = '' as $$
  with filtered as (
    select * from public.s2a_usage u where u.created_at >= p_start and u.created_at < p_end
      and (p_user_id is null or u.user_id = p_user_id) and u.model <> '__models__'
      and (p_key_id is null or u.key_id = p_key_id) and (p_model is null or u.model = p_model)
  ), latest as (
    select distinct on (request_id) * from filtered order by request_id, created_at desc, id desc
  ), summary as (
    select jsonb_build_object(
      'requests', (select count(*) from latest), 'attempts', count(*),
      'completed', (select count(*) from latest where outcome = 'completed'),
      'input_tokens', coalesce(sum(input_tokens),0), 'output_tokens', coalesce(sum(output_tokens),0),
      'cache_creation_tokens', coalesce(sum(cache_creation_tokens),0),
      'cache_read_tokens', coalesce(sum(cache_read_tokens),0),
      'total_cost',coalesce(sum(total_cost),0), 'actual_cost',coalesce(sum(actual_cost),0),
      'unknown_cost_attempts',count(*) filter(where total_cost is null),
      'unknown_attempts', count(*) filter (where input_tokens is null or output_tokens is null),
      'avg_duration_ms', coalesce(round(avg(duration_ms)),0)
    ) value from filtered
  ), days as (
    select generate_series(date_trunc(p_granularity, case when p_include_series then p_start at time zone p_timezone end),
      date_trunc(p_granularity, (p_end - interval '1 microsecond') at time zone p_timezone),
      case when p_granularity = 'hour' then interval '1 hour' else interval '1 day' end) as bucket
  ), daily as (
    select to_char(d.bucket, case when p_granularity = 'hour' then 'YYYY-MM-DD HH24:MI' else 'YYYY-MM-DD' end) as day,
      count(distinct u.request_id) requests, coalesce(sum(u.input_tokens),0) input_tokens,
      coalesce(sum(u.output_tokens),0) output_tokens,
      coalesce(sum(u.cache_creation_tokens),0) cache_creation_tokens,
      coalesce(sum(u.cache_read_tokens),0) cache_read_tokens,
      coalesce(sum(u.total_cost),0) total_cost,coalesce(sum(u.actual_cost),0) actual_cost,
      count(u.id) filter(where u.total_cost is null) unknown_cost_attempts
      from days d left join filtered u on date_trunc(p_granularity, u.created_at at time zone p_timezone) = d.bucket
      group by d.bucket order by d.bucket
  ), models as (
    select model, count(distinct request_id) requests, count(*) attempts,
      coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens,
      coalesce(sum(cache_creation_tokens),0) cache_creation_tokens,
      coalesce(sum(cache_read_tokens),0) cache_read_tokens,
      coalesce(sum(total_cost),0) total_cost,coalesce(sum(actual_cost),0) actual_cost,
      count(*) filter(where total_cost is null) unknown_cost_attempts
      from filtered group by model
      order by sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) desc, model limit 20
  ) select jsonb_build_object('summary', (select value from summary),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily)) from daily),'[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(models)) from models),'[]'::jsonb));
$$;


-- Keep a single defaulted overload for PostgREST named-argument resolution.
drop function public.s2a_group_create(text,uuid,text);
create function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1)
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 insert into public.s2a_groups(name,platform,rate_multiplier) values(p_name,p_platform,p_rate_multiplier) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;
revoke all on function public.s2a_group_create(text,uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.s2a_group_create(text,uuid,text,numeric) to service_role;

create or replace function public.s2a_wallet_adjust(
 p_user_id uuid,p_delta numeric,p_reason text,p_notes text default '',p_actor_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare w public.s2a_wallets; next_balance numeric(20,8);
begin
 if p_delta is null or p_delta::text in ('NaN','Infinity','-Infinity') or p_delta=0 or abs(p_delta)>1000000000 or p_delta<>round(p_delta,8) then
  return jsonb_build_object('error','invalid_balance_delta','status',400);
 end if;
 if not exists(select 1 from auth.users where id=p_user_id) then return jsonb_build_object('error','user_not_found','status',404); end if;
 insert into public.s2a_wallets(user_id) values(p_user_id) on conflict do nothing;
 select * into w from public.s2a_wallets where user_id=p_user_id for update;
 next_balance := w.balance+p_delta;
 if next_balance<w.frozen_balance and next_balance<w.balance then return jsonb_build_object('error','insufficient_balance','status',409); end if;
 update public.s2a_wallets set balance=next_balance,updated_at=now() where user_id=p_user_id;
 insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes,actor_id)
  values(p_user_id,p_delta,next_balance,left(coalesce(p_reason,'manual'),200),left(coalesce(p_notes,''),2000),p_actor_id);
 return jsonb_build_object('user_id',p_user_id,'balance',next_balance,'frozen_balance',w.frozen_balance,'updated_at',now());
end $$;

create or replace function public.s2a_wallet_history(p_user_id uuid,p_page integer,p_size integer,p_type text default '')
returns jsonb language sql stable set search_path = '' as $$
 with filtered as (
  select * from public.s2a_wallet_ledger where user_id=p_user_id and reason<>'usage'
   and (p_type='' or p_type='admin_balance' and reason in ('admin_set','admin_add','admin_subtract'))
 ), entries as (
  select id, '' as code, 'admin_balance' as type, delta as value,
   'used' as status, user_id as used_by, created_at as used_at, created_at,
   null::uuid as group_id, 0 as validity_days, notes, balance_after
  from filtered order by created_at desc,id desc limit p_size offset (p_page-1)*p_size
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(entries)) from entries),'[]'::jsonb),
  'total',(select count(*) from filtered),'page',p_page,'page_size',p_size,
  'pages',ceil((select count(*) from filtered)::numeric/p_size),
  'total_recharged',(select coalesce(sum(delta),0) from public.s2a_wallet_ledger
    where user_id=p_user_id and delta>0 and reason='admin_add'));
$$;
