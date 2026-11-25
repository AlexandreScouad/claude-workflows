-- Pilote TokenEconomizer : choix des dépôts pilotes et du groupe témoin.
-- Voir docs/pilote-token-economizer.md, section « Choisir les dépôts pilotes ».
--
-- Activité de l'étape `implement` de `Claude Dev` sur 60 jours, par projet
-- feedback-app, depuis claude_usage_runs (alimentée par scripts/report-usage.cjs).
--
-- LECTURE SEULE, sur la base de feedback-app. Jamais de `SET` de session sur
-- DATABASE_URL (pooler en mode transaction, règle 10 du CLAUDE.md de
-- feedback-app) : la transaction read only est ouverte et fermée ici, sur le
-- même client.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/pilote-token-economizer-choix-depots.sql
--
-- Lecture du résultat :
--   - candidat         : assez de runs réguliers pour boucler les phases 1 et 2
--                        (~10 + ~15 runs) en 10 semaines environ ;
--   - témoin           : actif, mais pas assez pour le pilote ; sert de
--                        comparaison sur la même période ;
--   - trop peu de runs : ignoré.
--   Prendre les 2 premiers « candidat ». S'il y en a moins de 2, prendre les
--   2 premières lignes et allonger les phases en conséquence.
--   `depot` est la valeur à mettre dans TOKENECONOMIZER_REPOS.

begin read only;

with runs as (
  select u.project_id, u.gh_issue_number, u.created_at,
         u.total_tokens, u.cache_read_tokens, u.cost_eur
  from claude_usage_runs u
  where u.workflow = 'Claude Dev'
    and u.step = 'implement'
    and u.created_at > now() - interval '60 days'
    -- 0 token = run bloqué par une limite d'usage, sans travail mesurable
    and u.total_tokens > 0
),
per_project as (
  select
    r.project_id,
    count(*)                                                      as runs_60j,
    count(*) filter (where r.created_at > now() - interval '30 days') as runs_30j,
    count(distinct r.gh_issue_number)                             as tickets_60j,
    count(distinct date_trunc('week', r.created_at))              as semaines_actives,
    round(count(*)::numeric / count(distinct r.gh_issue_number), 2) as runs_par_ticket,
    percentile_cont(0.5)  within group (order by r.total_tokens)::bigint as tokens_median,
    percentile_cont(0.75) within group (order by r.total_tokens)::bigint as tokens_p75,
    round(100.0 * sum(r.cache_read_tokens) / sum(r.total_tokens), 1)  as pct_cache_read,
    round(sum(r.cost_eur), 2)                                     as cout_eur_60j,
    max(r.created_at)::date                                       as dernier_run
  from runs r
  group by r.project_id
)
select
  p.slug,
  case when p.github_owner is not null and p.github_repo is not null
       then lower(p.github_owner || '/' || p.github_repo) end     as depot,
  pp.runs_30j,
  pp.runs_60j,
  pp.tickets_60j,
  pp.semaines_actives,
  pp.runs_par_ticket,
  pp.tokens_median,
  pp.tokens_p75,
  pp.pct_cache_read,
  pp.cout_eur_60j,
  pp.dernier_run,
  case
    when pp.runs_30j >= 10 and pp.semaines_actives >= 6 then 'candidat'
    when pp.runs_60j >= 5                               then 'témoin'
    else                                                     'trop peu de runs'
  end                                                             as role_propose
from per_project pp
join projects p on p.id = pp.project_id
order by (pp.runs_30j >= 10 and pp.semaines_actives >= 6) desc,
         pp.runs_30j desc,
         pp.runs_60j desc;

commit;
