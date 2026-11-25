-- Pilote TokenEconomizer : comparaison avant / après, pilotes contre témoin.
-- Voir docs/pilote-token-economizer.md, section « Mesure ».
--
-- Étape `implement` de `Claude Dev` (claude_usage_runs). Trois périodes :
--   avant        : les 60 jours précédant debut_shadow ;
--   observation  : de debut_shadow à debut_on (phase 1, le plugin n'agit pas) ;
--   apres        : de debut_on à fin (phase 2, le plugin agit).
-- Deux groupes :
--   pilote : les dépôts listés dans `pilotes` ;
--   temoin : les autres projets avec au moins 5 runs « avant » et 3 runs « apres ».
--
-- LECTURE SEULE, sur la base de feedback-app. Jamais de `SET` de session sur
-- DATABASE_URL (pooler en mode transaction, règle 10 du CLAUDE.md de
-- feedback-app) : la transaction read only est ouverte et fermée ici. Pas de
-- table temporaire (refusée en read only) : chaque requête répète le même bloc
-- `params / runs / groupes / base`.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v pilotes='acme/app,acme/site' \
--     -v debut_shadow='2026-12-01' \
--     -v debut_on='2026-12-29' \
--     [-v fin='2027-02-15'] \
--     [-v surcout_tokens=1234567] \
--     -f docs/pilote-token-economizer-comparaison.sql
--
--   pilotes        : valeurs de TOKENECONOMIZER_REPOS (owner/repo, séparés par des virgules)
--   debut_shadow   : date du passage en phase 1 (TOKENECONOMIZER_PHASE=shadow)
--   debut_on       : date du passage en phase 2 (TOKENECONOMIZER_PHASE=on)
--   fin            : fin de la mesure (défaut : maintenant)
--   surcout_tokens : tokens des appels propres du plugin sur les dépôts pilotes pendant
--                    « apres », lus sur le VPS (`te status`, ligne « plugin overhead »).
--                    Ils ne sont PAS dans claude_usage_runs. Défaut : 0.
--
-- Limites : quelques dizaines de runs, tickets hétérogènes. Le résultat est
-- indicatif, pas statistiquement significatif. La 3ᵉ requête montre si le mélange
-- de tickets (type, taille) a changé entre les périodes.

\if :{?pilotes}
\else
  \echo 'Variable manquante : -v pilotes=owner/repo[,owner/repo]'
  \quit
\endif
\if :{?debut_shadow}
\else
  \echo 'Variable manquante : -v debut_shadow=AAAA-MM-JJ'
  \quit
\endif
\if :{?debut_on}
\else
  \echo 'Variable manquante : -v debut_on=AAAA-MM-JJ'
  \quit
\endif
\if :{?fin}
\else
  \set fin now
\endif
\if :{?surcout_tokens}
\else
  \set surcout_tokens 0
\endif

begin read only;

\echo
\echo '== 1. Par groupe et période (lignes « slug » : détail par dépôt pilote) =='

with params as (
  select string_to_array(lower(replace(:'pilotes', ' ', '')), ',') as pilotes,
         (:'debut_shadow')::timestamptz as debut_shadow,
         (:'debut_on')::timestamptz     as debut_on,
         (:'fin')::timestamptz          as fin
),
runs as (
  select u.project_id, u.gh_issue_number, u.total_tokens, u.cost_eur::float8 as cost_eur,
         p.slug, lower(p.github_owner || '/' || p.github_repo) as depot,
         case when u.created_at < pa.debut_shadow then 'avant'
              when u.created_at < pa.debut_on     then 'observation'
              else 'apres' end as periode
  from claude_usage_runs u
  join projects p on p.id = u.project_id
  cross join params pa
  where u.workflow = 'Claude Dev' and u.step = 'implement' and u.total_tokens > 0
    and u.created_at >= pa.debut_shadow - interval '60 days'
    and u.created_at <  pa.fin
),
groupes as (
  select r.project_id,
         case when bool_or(r.depot = any (pa.pilotes)) then 'pilote'
              when count(*) filter (where r.periode = 'avant') >= 5
               and count(*) filter (where r.periode = 'apres') >= 3 then 'temoin'
         end as groupe
  from runs r cross join params pa
  group by r.project_id
),
base as (
  select r.*, g.groupe from runs r join groupes g using (project_id) where g.groupe is not null
)
select groupe,
       slug,
       periode,
       count(distinct project_id)                                   as projets,
       count(*)                                                     as runs,
       count(distinct (project_id, gh_issue_number))                as tickets,
       round(count(*)::numeric / count(distinct (project_id, gh_issue_number)), 2) as runs_par_ticket,
       percentile_cont(0.5)  within group (order by total_tokens)::bigint as tokens_median,
       percentile_cont(0.75) within group (order by total_tokens)::bigint as tokens_p75,
       round((percentile_cont(0.5) within group (order by cost_eur))::numeric, 2) as cout_median_eur
from base
group by grouping sets ((groupe, periode), (groupe, slug, periode))
having slug is null or groupe = 'pilote'
order by groupe, slug nulls first,
         case periode when 'avant' then 1 when 'observation' then 2 else 3 end;

\echo
\echo '== 2. Synthèse : différence de différences sur les médianes, et verdict =='

with params as (
  select string_to_array(lower(replace(:'pilotes', ' ', '')), ',') as pilotes,
         (:'debut_shadow')::timestamptz as debut_shadow,
         (:'debut_on')::timestamptz     as debut_on,
         (:'fin')::timestamptz          as fin
),
runs as (
  select u.project_id, u.gh_issue_number, u.total_tokens, u.cost_eur::float8 as cost_eur,
         p.slug, lower(p.github_owner || '/' || p.github_repo) as depot,
         case when u.created_at < pa.debut_shadow then 'avant'
              when u.created_at < pa.debut_on     then 'observation'
              else 'apres' end as periode
  from claude_usage_runs u
  join projects p on p.id = u.project_id
  cross join params pa
  where u.workflow = 'Claude Dev' and u.step = 'implement' and u.total_tokens > 0
    and u.created_at >= pa.debut_shadow - interval '60 days'
    and u.created_at <  pa.fin
),
groupes as (
  select r.project_id,
         case when bool_or(r.depot = any (pa.pilotes)) then 'pilote'
              when count(*) filter (where r.periode = 'avant') >= 5
               and count(*) filter (where r.periode = 'apres') >= 3 then 'temoin'
         end as groupe
  from runs r cross join params pa
  group by r.project_id
),
base as (
  select r.*, g.groupe from runs r join groupes g using (project_id) where g.groupe is not null
),
stats as (
  select groupe, periode,
         count(*) as runs,
         count(*)::numeric / count(distinct (project_id, gh_issue_number)) as runs_par_ticket,
         percentile_cont(0.5) within group (order by total_tokens) as tokens_median,
         percentile_cont(0.5) within group (order by cost_eur)     as cout_median
  from base
  where periode in ('avant', 'apres')
  group by groupe, periode
),
calc as (
  select
    pa.runs as runs_pilote_avant, pp.runs as runs_pilote_apres,
    ta.runs as runs_temoin_avant, tp.runs as runs_temoin_apres,
    pa.tokens_median as pilote_avant, pp.tokens_median as pilote_apres,
    -- surcoût du plugin réparti sur les runs « apres » des pilotes (approximation)
    pp.tokens_median + (:surcout_tokens)::float8 / nullif(pp.runs, 0) as pilote_apres_corrige,
    ta.tokens_median as temoin_avant, tp.tokens_median as temoin_apres,
    pa.cout_median as cout_pilote_avant, pp.cout_median as cout_pilote_apres,
    ta.cout_median as cout_temoin_avant, tp.cout_median as cout_temoin_apres,
    pp.runs_par_ticket - pa.runs_par_ticket as delta_relances_pilote,
    tp.runs_par_ticket - ta.runs_par_ticket as delta_relances_temoin
  from (select 1) one
  left join stats pa on pa.groupe = 'pilote' and pa.periode = 'avant'
  left join stats pp on pp.groupe = 'pilote' and pp.periode = 'apres'
  left join stats ta on ta.groupe = 'temoin' and ta.periode = 'avant'
  left join stats tp on tp.groupe = 'temoin' and tp.periode = 'apres'
),
evol as (
  select c.*,
    100 * (c.pilote_apres_corrige / c.pilote_avant - 1) as evol_tokens_pilote_pct,
    100 * (c.temoin_apres / c.temoin_avant - 1)         as evol_tokens_temoin_pct,
    100 * (c.cout_pilote_apres / nullif(c.cout_pilote_avant, 0) - 1) as evol_cout_pilote_pct,
    100 * (c.cout_temoin_apres / nullif(c.cout_temoin_avant, 0) - 1) as evol_cout_temoin_pct
  from calc c
)
select
  runs_pilote_avant, runs_pilote_apres, runs_temoin_avant, runs_temoin_apres,
  pilote_avant::bigint          as tokens_pilote_avant,
  pilote_apres::bigint          as tokens_pilote_apres,
  pilote_apres_corrige::bigint  as tokens_pilote_apres_avec_surcout,
  temoin_avant::bigint          as tokens_temoin_avant,
  temoin_apres::bigint          as tokens_temoin_apres,
  round(evol_tokens_pilote_pct::numeric, 1)                             as evol_tokens_pilote_pct,
  round(evol_tokens_temoin_pct::numeric, 1)                             as evol_tokens_temoin_pct,
  round((evol_tokens_pilote_pct - evol_tokens_temoin_pct)::numeric, 1)  as ecart_tokens_points,
  -- coût : sans le surcoût du plugin (claude_usage_runs ne le contient pas)
  round(evol_cout_pilote_pct::numeric, 1)                               as evol_cout_pilote_hors_surcout_pct,
  round(evol_cout_temoin_pct::numeric, 1)                               as evol_cout_temoin_pct,
  round((evol_cout_pilote_pct - evol_cout_temoin_pct)::numeric, 1)      as ecart_cout_hors_surcout_points,
  round(delta_relances_pilote, 2)                                       as delta_relances_pilote,
  round(delta_relances_temoin, 2)                                       as delta_relances_temoin,
  case
    when runs_pilote_avant is null or runs_pilote_apres is null then 'pas de run pilote sur une période'
    when runs_temoin_avant is null or runs_temoin_apres is null then 'pas de témoin : comparaison impossible'
    when runs_pilote_apres < 15                                  then 'échantillon insuffisant (< 15 runs pilotes « apres »)'
    when delta_relances_pilote - delta_relances_temoin > 0.25    then 'qualité en baisse : plus de relances que le témoin'
    when evol_tokens_pilote_pct - evol_tokens_temoin_pct <= -10  then 'critère de gain atteint (≥ 10 points sous le témoin)'
    else 'critère de gain non atteint'
  end as verdict
from evol;

\echo
\echo '== 3. Mélange des tickets (part des runs par type et par taille) =='

with params as (
  select string_to_array(lower(replace(:'pilotes', ' ', '')), ',') as pilotes,
         (:'debut_shadow')::timestamptz as debut_shadow,
         (:'debut_on')::timestamptz     as debut_on,
         (:'fin')::timestamptz          as fin
),
runs as (
  select u.project_id, u.gh_issue_number, u.total_tokens, u.cost_eur::float8 as cost_eur,
         p.slug, lower(p.github_owner || '/' || p.github_repo) as depot,
         case when u.created_at < pa.debut_shadow then 'avant'
              when u.created_at < pa.debut_on     then 'observation'
              else 'apres' end as periode
  from claude_usage_runs u
  join projects p on p.id = u.project_id
  cross join params pa
  where u.workflow = 'Claude Dev' and u.step = 'implement' and u.total_tokens > 0
    and u.created_at >= pa.debut_shadow - interval '60 days'
    and u.created_at <  pa.fin
),
groupes as (
  select r.project_id,
         case when bool_or(r.depot = any (pa.pilotes)) then 'pilote'
              when count(*) filter (where r.periode = 'avant') >= 5
               and count(*) filter (where r.periode = 'apres') >= 3 then 'temoin'
         end as groupe
  from runs r cross join params pa
  group by r.project_id
),
base as (
  select r.*, g.groupe from runs r join groupes g using (project_id) where g.groupe is not null
),
avec_ticket as (
  select b.groupe, b.periode,
         coalesce(t.type::text, '?')  as type_ticket,
         coalesce(e.size, '?')        as taille
  from base b
  left join lateral (
    select t.type, t.plane_issue_id
    from tickets t
    where t.project_id = b.project_id and t.gh_issue_number = b.gh_issue_number
    limit 1
  ) t on true
  left join estimations e on e.project_id = b.project_id and e.plane_issue_id = t.plane_issue_id
)
select groupe, axe, periode, valeur, runs, pct
from (
  select groupe, periode, 'type' as axe, type_ticket as valeur, count(*) as runs,
         round(100.0 * count(*) / sum(count(*)) over (partition by groupe, periode), 0) as pct
  from avec_ticket group by groupe, periode, type_ticket
  union all
  select groupe, periode, 'taille', taille, count(*),
         round(100.0 * count(*) / sum(count(*)) over (partition by groupe, periode), 0)
  from avec_ticket group by groupe, periode, taille
) m
order by groupe, axe,
         case periode when 'avant' then 1 when 'observation' then 2 else 3 end,
         valeur;

commit;
