insert into storage.buckets(id,name,public,file_size_limit)
 values('s2a-pages','s2a-pages',false,52428800)
 on conflict(id) do update set public=false,file_size_limit=52428800;
