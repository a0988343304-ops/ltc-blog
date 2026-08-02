-- =============================================================
-- 瀏覽計數器資料表 / Supabase SQL Editor 貼上執行一次即可
-- =============================================================

-- 1) 計數表：一個 slug 一列
create table if not exists public.page_views (
  slug        text primary key,
  views       bigint      not null default 0,
  updated_at  timestamptz not null default now()
);

-- 2) 開啟 RLS。沒有政策 = 全部拒絕，之後再逐一開放。
alter table public.page_views enable row level security;

-- 3) 只開放「讀取」給匿名訪客（首頁卡片要能顯示各篇的次數）
drop policy if exists "anon can read view counts" on public.page_views;
create policy "anon can read view counts"
  on public.page_views
  for select
  to anon
  using (true);

--    注意：這裡刻意「不」開放 anon 的 insert / update / delete。
--    寫入一律走下面的函式，訪客沒辦法直接把數字改成任意值。

-- 4) 計數 +1 的函式。security definer 讓它以擁有者身分繞過 RLS 寫入。
create or replace function public.increment_view(page_slug text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_views bigint;
begin
  -- 基本防呆：slug 只允許英數、連字號、底線，長度上限 128
  if page_slug is null or page_slug !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'invalid slug';
  end if;

  insert into public.page_views as pv (slug, views)
  values (page_slug, 1)
  on conflict (slug) do update
    set views = pv.views + 1,
        updated_at = now()
  returning pv.views into new_views;

  return new_views;
end;
$$;

-- 5) 允許匿名訪客呼叫這支函式
grant execute on function public.increment_view(text) to anon;

-- 完成。可用下面兩行測試：
--   select public.increment_view('site-home');
--   select * from public.page_views;
