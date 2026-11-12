-- 관리자 회원 관리(2026-11-12) — 사주결 Supabase(SQL Editor)에서 한 번 실행한다. 읽기 전용.
-- 관리자(public.is_admin())만 결과를 받는다. 이메일·카카오 id·전화번호·출생 정보는 돌려주지 않는다(닉네임·가입일·최근 접속·구매·쿠폰 상태만).
-- 구매 = 결제 완료(status=paid)·환불 안 됨·0원 초과·관리자 무료 열람(admin_bypass)/이용권 사용(qa_credit)/시험 결제(*test*) 제외.
create or replace function public.admin_member_overview(
  p_q text default null, p_sort text default 'joined', p_limit integer default 100, p_offset integer default 0
) returns jsonb
language sql stable security definer set search_path to 'public'
as $$
with base as (
  select u.id, coalesce(nullif(p.nickname, ''), '(이름 없음)') as name, coalesce(p.is_admin, false) as is_admin,
         u.created_at as joined_at, u.last_sign_in_at as last_login_at
  from auth.users u left join public.profiles p on p.id = u.id
  where public.is_admin()
),
pay as (
  select user_id, count(*) as paid_count, coalesce(sum(amount), 0) as paid_amount, max(created_at) as last_paid_at
  from public.purchases
  where status::text = 'paid' and refunded_at is null and amount > 0 and user_id is not null
    and coalesce(pg_provider, '') not in ('admin_bypass', 'qa_credit') and coalesce(pg_provider, '') not like '%test%'
  group by user_id
),
m as (
  select b.*, left(b.id::text, 8) as ref,
         coalesce(py.paid_count, 0) as paid_count, coalesce(py.paid_amount, 0) as paid_amount, py.last_paid_at,
         case when c.id is null then 'none' when c.status = 'used' then 'used' when c.expires_at <= now() then 'expired'
              when c.reserved_until is not null and c.reserved_until > now() then 'reserved' else 'available' end as coupon
  from base b left join pay py on py.user_id = b.id left join public.signup_coupons c on c.user_id = b.id
),
real as (select * from m where not is_admin),
days as (select ((now() at time zone 'Asia/Seoul')::date - g) as d from generate_series(0, 13) g),
filtered as (
  select * from m
  where p_q is null or btrim(p_q) = '' or lower(name) like '%' || lower(btrim(p_q)) || '%' or ref like lower(btrim(p_q)) || '%'
),
page as (
  select f.*, row_number() over (order by
      case when p_sort = 'last_login' then f.last_login_at end desc nulls last,
      case when p_sort = 'paid_amount' then f.paid_amount end desc nulls last,
      case when p_sort = 'paid_count' then f.paid_count end desc nulls last,
      f.joined_at desc) as rn
  from filtered f
)
select case when not public.is_admin() then null else jsonb_build_object(
  'summary', jsonb_build_object(
    'total', (select count(*) from real),
    'admins', (select count(*) from m where is_admin),
    'new_today', (select count(*) from real where (joined_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'new_7d', (select count(*) from real where joined_at > now() - interval '7 days'),
    'new_30d', (select count(*) from real where joined_at > now() - interval '30 days'),
    'active_7d', (select count(*) from real where last_login_at > now() - interval '7 days'),
    'buyers', (select count(*) from real where paid_count > 0),
    'paid_orders', (select coalesce(sum(paid_count), 0) from real),
    'revenue', (select coalesce(sum(paid_amount), 0) from real),
    'coupon', jsonb_build_object(
      'issued', (select count(*) from real where coupon <> 'none'),
      'available', (select count(*) from real where coupon = 'available'),
      'reserved', (select count(*) from real where coupon = 'reserved'),
      'used', (select count(*) from real where coupon = 'used'),
      'expired', (select count(*) from real where coupon = 'expired')),
    'daily_new', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'n', (select count(*) from real where (joined_at at time zone 'Asia/Seoul')::date = d)) order by d) from days)
  ),
  'total_filtered', (select count(*) from filtered),
  'members', coalesce((select jsonb_agg(jsonb_build_object('ref', ref, 'name', name, 'is_admin', is_admin, 'joined_at', joined_at, 'last_login_at', last_login_at,
      'paid_count', paid_count, 'paid_amount', paid_amount, 'last_paid_at', last_paid_at, 'coupon', coupon) order by rn)
      from page where rn > greatest(0, coalesce(p_offset, 0)) and rn <= greatest(0, coalesce(p_offset, 0)) + greatest(1, least(coalesce(p_limit, 100), 500))), '[]'::jsonb)
) end;
$$;
revoke all on function public.admin_member_overview(text, text, integer, integer) from public, anon;
grant execute on function public.admin_member_overview(text, text, integer, integer) to authenticated;
-- 롤백: drop function public.admin_member_overview(text, text, integer, integer);
