import * as core from '@actions/core'
import { graphql } from '@octokit/graphql'
import { promises as fs } from 'fs'

enum TEMPS {
    ISSUES = "ISSUES",
    PULL_REQUESTS = "PULL_REQUESTS",
    COMMITS = "COMMITS",
    LANGAUGE_TEMPLATE_START = "LANGAUGE_TEMPLATE_START",
    LANGAUGE_TEMPLATE_END = "LANGAUGE_TEMPLATE_END",
    LANGUAGE_NAME = "LANGUAGE_NAME",
    LANGUAGE_PERCENT = "LANGUAGE_PERCENT"
}

interface Repo {
    languages: {
        edges: Array<{
            size: number
            node: {
                name: string
            }
        }>
    }
}

async function weeklyRepoLangs(gql: typeof graphql)
{
    const date = new Date()
    const week = 7 * 24 * 60 * 60 * 1000
    date.setUTCHours(0, 0, 0, 0)
    date.setUTCDate(date.getUTCDate() - week)
    let q = 
    `{
        viewer
        {
            contributionsCollection(from:"${date.toISOString()}")
            {
                commitContributionsByRepository(maxRepositories:100)
                {
                    repository{
                        nodes
                        {
                            languages(first:100)
                            { 
                                edges {
                                    size
                                    node {
                                        name
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }`

    interface QueryResult {
        viewer: {
            contributionsCollection: {
                commitContributionsByRepository: {
                    repository: {
                        nodes: Repo[]
                    }
                }
            }
        }
    }

    const res = await gql<QueryResult>(q)

    return res.viewer.contributionsCollection.commitContributionsByRepository.repository.nodes
}

function getDateTime(year: number) {
    const date = new Date()
    date.setUTCFullYear(year, 0, 1)
    date.setUTCHours(0, 0, 0, 0)
    return date.toISOString()
}

async function calculateCommits(gql: typeof graphql, years: number[])
{
    let q = `{viewer{`
    for (const year of years)
    {
        q += `_${year}: contributionsCollection(from: "${getDateTime(year)}")`
        q += `{totalCommitContributions}`
    }
    q += `}}`

    interface QueryResult {
        viewer: Record<string, { totalCommitContributions: number }>
    }

    const res = await gql<QueryResult>(q)
    return Object.keys(res.viewer)
        .map(key => res.viewer[key].totalCommitContributions)
        .reduce((tot, curr) => tot + curr, 0)
}

async function getUserInfo(gql: typeof graphql)
{
    const query = 
    `{
        viewer {
            issues {
                totalCount
            }
            pullRequests {
                totalCount
            }
            contributionsCollection {
                contributionYears
            }
            repositories(affiliations: COLLABORATOR, first: 100) {
                nodes {
                    languages(first: 100) {
                        edges {
                            size
                            node {
                                name
                            }
                        }
                    }
                }
            }
        }
        rateLimit { cost remaining resetAt }
    }`

    interface QueryResult {
        viewer: {
            issues: {
                totalCount: number
            }
            pullRequests: {
                totalCount: number
            }
            contributionsCollection: {
                contributionYears: number[]
            }
            repositories: {
                nodes: Repo[]
            }
        }
        rateLimit: {
            cost: number
            remaining: number
            resetAt: string
        }
    }

    const { viewer, rateLimit } = await gql<QueryResult>(query)

    return {
        iss: viewer.issues.totalCount,
        prs: viewer.pullRequests.totalCount,
        comms: viewer.contributionsCollection.contributionYears,
        langs: viewer.repositories.nodes
    }

}

function replaceTemplate(input: string, temp: TEMPS, value: string | number)
{
    return input.replace(new RegExp(`\{\{\s*${temp}\s*\}\}`, 'g'), value.toString())
}

function getLanguages(repos: Repo[])
{
    interface Lang {
        name: string
        size: number
        percent: number
    }

    const languages = new Map<string, Lang>()
    for (const repo of repos)
    {
        for (const lang of repo.languages.edges)
        {
            const exist = languages.get(lang.node.name)
            if (exist)
            {
                exist.size += lang.size
            } else
            {
                languages.set(lang.node.name, {
                    name: (lang.node.name.length > 12)?
                        (lang.node.name.substring(0, 9)+"..."):
                        (lang.node.name+"            ").substring(0, 12),
                    size: lang.size,
                    percent: 0
                })
            }
        }
    }

    const langs = [...languages.values()].sort((a,b) => b.size-a.size)
    const total = langs.reduce((tot, curr) => tot + curr.size, 0)

    const getPercent = (size: number) => ((size / total) * 100)
    for (const lang of langs)
    {
        lang.percent = getPercent(lang.size)
    }

    let maxLangs = 5
    const index = langs.findIndex(lang => lang.percent === 0)
    if ((index !== -1) && (index+1 < maxLangs))
    {
        maxLangs = index+1
    }

    if (maxLangs < langs.length)
    {
        const size = langs
            .slice(maxLangs-1)
            .reduce((tot, curr) => tot + curr.size, 0)
        const percent = getPercent(size)

        if (percent !== 0)
        {
            langs.push({
                name: "Other     ",
                size,
                percent
            })
        }
    }

    return langs
}

function replaceLanguages(input: string, repos: Repo[])
{
    const lang_start = new RegExp(`\{\{\s*${TEMPS.LANGAUGE_TEMPLATE_START}\s*\}\}\n?`, 'g')
    const lang_stop = new RegExp(`\{\{\s*${TEMPS.LANGAUGE_TEMPLATE_END}\s*\}\}\n?`, 'g')

    interface Replacement {
        start: number
        end: number
        rep: string
    }

    const reps: Replacement[] = []
    for (const match of input.matchAll(lang_start))
    {
        if (match.index=== undefined) continue
        const max = 5
        const end = match.index + match[0].length
        const s = input.substring(end)
        const endMatch = s.search(lang_stop)
        if (endMatch === -1) continue
        const str = s.substring(0, endMatch)
        const rep = getLanguages(repos)
            .map(lang => {
                let res = str
                let bar = ""
                for (var i = 0; i < (lang.percent/4); i++) bar += "█"
                bar += ((lang.percent/4)/2)?"▓":"▒"
                for (var i = 0; i < (25-(lang.percent/4)); i++) bar += "░"
                bar += ("   "+Math.round(lang.percent*100)/100+" %")
                res = replaceTemplate(res, TEMPS.LANGUAGE_NAME, lang.name)
                res = replaceTemplate(res, TEMPS.LANGUAGE_PERCENT, bar)
                return res
            })
            .reduce((tot, curr) => tot + curr, '')
        reps.push({
            start: end,
            end: end + endMatch,
            rep
        })
    }

    let out = ''
    let start = 0
    for (const rep of reps)
    {
        out += input.substring(start, rep.start)
        out += rep.rep
        start = rep.end
    }
    out += input.substring(start, input.length)
    out = out.replace(lang_start, '').replace(lang_stop, '')
    return out
}

async function run(): Promise<void>
{
    const token = core.getInput('token')
    const gql = graphql.defaults({
        headers: { authorization: `token ${token}` }
    })

    const {
        iss,
        prs,
        comms,
        langs
    } = await getUserInfo(gql)

    //const weeklyLangs = await weeklyRepoLangs(gql)

    console.log("test")
    let readme = await fs.readFile('./TEMPLATE.md', 'utf8')
    readme = replaceTemplate(readme, TEMPS.ISSUES, iss)
    readme = replaceTemplate(readme, TEMPS.PULL_REQUESTS, prs)
    readme = replaceTemplate(readme, TEMPS.COMMITS, await calculateCommits(gql, comms))
    readme = replaceLanguages(readme, langs)
    await fs.writeFile(readme, "./README.md")
}

run().catch(error => core.setFailed(error.message))