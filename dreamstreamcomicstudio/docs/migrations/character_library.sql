-- Create a table for storing reusable characters across projects
create table if not exists character_library (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  name text not null,
  description text, -- visual prompt
  bio text, -- backstory
  image_url text, -- avatar
  reference_image_ids text[], -- array of image references from storage
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
alter table character_library enable row level security;

-- Policies
create policy "Users can view their own characters" 
  on character_library for select 
  using (auth.uid() = user_id);

create policy "Users can insert their own characters" 
  on character_library for insert 
  with check (auth.uid() = user_id);

create policy "Users can update their own characters" 
  on character_library for update 
  using (auth.uid() = user_id);

create policy "Users can delete their own characters" 
  on character_library for delete 
  using (auth.uid() = user_id);

-- Add index on user_id for performance
create index if not exists idx_character_library_user_id on character_library(user_id);
