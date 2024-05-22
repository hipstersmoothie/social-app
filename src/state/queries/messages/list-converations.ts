import {useCallback, useMemo} from 'react'
import {
  ChatBskyConvoDefs,
  ChatBskyConvoListConvos,
  moderateProfile,
} from '@atproto/api'
import {
  InfiniteData,
  QueryClient,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {useProfileShadowGetter} from '#/state/cache/profile-shadow'
import {useCurrentConvoId} from '#/state/messages/current-convo-id'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {DM_SERVICE_HEADERS} from '#/state/queries/messages/const'
import {useAgent, useSession} from '#/state/session'

export const RQKEY = ['convo-list']
type RQPageParam = string | undefined

export function useListConvos({refetchInterval}: {refetchInterval: number}) {
  const {getAgent} = useAgent()

  return useInfiniteQuery({
    queryKey: RQKEY,
    queryFn: async ({pageParam}) => {
      const {data} = await getAgent().api.chat.bsky.convo.listConvos(
        {cursor: pageParam},
        {headers: DM_SERVICE_HEADERS},
      )

      return data
    },
    initialPageParam: undefined as RQPageParam,
    getNextPageParam: lastPage => lastPage.cursor,
    refetchInterval,
  })
}

export function useUnreadMessageCount() {
  const {currentConvoId} = useCurrentConvoId()
  const {currentAccount} = useSession()
  const query = useListConvos({
    refetchInterval: 30_000,
  })
  const moderationOpts = useModerationOpts()

  const convos = useMemo(() => {
    return query.data?.pages.flatMap(page => page.convos) ?? []
  }, [query.data])

  const getShadow = useProfileShadowGetter(getProfilesFromConvoMembers(convos))

  const count =
    convos.reduce((acc, convo) => {
      if (convo.id === currentConvoId) return acc

      const otherMemberUnshadowed = convo.members.find(
        member => member.did !== currentAccount?.did,
      )

      if (
        !otherMemberUnshadowed ||
        !moderationOpts ||
        otherMemberUnshadowed.did === 'missing.invalid'
      ) {
        return acc
      }

      const otherMember = getShadow(otherMemberUnshadowed)

      const moderation = moderateProfile(otherMember, moderationOpts)
      const shouldIgnore = convo.muted || moderation.blocked
      const unreadCount = !shouldIgnore && convo.unreadCount > 0 ? 1 : 0

      return acc + unreadCount
    }, 0) ?? 0

  return useMemo(() => {
    return {
      count,
      numUnread: count > 0 ? (count > 30 ? '30+' : String(count)) : undefined,
    }
  }, [count])
}

function getProfilesFromConvoMembers(
  convos: ChatBskyConvoDefs.ConvoView[],
  currentAccountDid?: string,
) {
  if (!convos) {
    return []
  }

  return convos
    .flatMap(
      convo => convo.members.find(member => member.did !== currentAccountDid)!,
    )
    .filter(Boolean)
}

type ConvoListQueryData = {
  pageParams: Array<string | undefined>
  pages: Array<ChatBskyConvoListConvos.OutputSchema>
}

export function useOnDeleteMessage() {
  const queryClient = useQueryClient()

  return useCallback(
    (chatId: string, messageId: string) => {
      queryClient.setQueryData(RQKEY, (old: ConvoListQueryData) => {
        return optimisticUpdate(chatId, old, convo =>
          messageId === convo.lastMessage?.id
            ? {
                ...convo,
                lastMessage: {
                  $type: 'chat.bsky.convo.defs#deletedMessageView',
                  id: messageId,
                  rev: '',
                },
              }
            : convo,
        )
      })
    },
    [queryClient],
  )
}

export function useOnNewMessage() {
  const queryClient = useQueryClient()

  return useCallback(
    (chatId: string, message: ChatBskyConvoDefs.MessageView) => {
      queryClient.setQueryData(RQKEY, (old: ConvoListQueryData) => {
        return optimisticUpdate(chatId, old, convo => ({
          ...convo,
          lastMessage: message,
          unreadCount: convo.unreadCount + 1,
        }))
      })
      queryClient.invalidateQueries({queryKey: RQKEY})
    },
    [queryClient],
  )
}

export function useOnCreateConvo() {
  const queryClient = useQueryClient()

  return useCallback(() => {
    queryClient.invalidateQueries({queryKey: RQKEY})
  }, [queryClient])
}

export function useOnMarkAsRead() {
  const queryClient = useQueryClient()

  return useCallback(
    (chatId: string) => {
      queryClient.setQueryData(RQKEY, (old: ConvoListQueryData) => {
        return optimisticUpdate(chatId, old, convo => ({
          ...convo,
          unreadCount: 0,
        }))
      })
    },
    [queryClient],
  )
}

function optimisticUpdate(
  chatId: string,
  old: ConvoListQueryData,
  updateFn: (convo: ChatBskyConvoDefs.ConvoView) => ChatBskyConvoDefs.ConvoView,
) {
  if (!old) {
    return old
  }

  return {
    ...old,
    pages: old.pages.map(page => ({
      ...page,
      convos: page.convos.map(convo =>
        chatId === convo.id ? updateFn(convo) : convo,
      ),
    })),
  }
}

export function* findAllProfilesInQueryData(
  queryClient: QueryClient,
  did: string,
) {
  const queryDatas = queryClient.getQueriesData<
    InfiniteData<ChatBskyConvoListConvos.OutputSchema>
  >({
    queryKey: RQKEY,
  })
  for (const [_queryKey, queryData] of queryDatas) {
    if (!queryData?.pages) {
      continue
    }

    for (const page of queryData.pages) {
      for (const convo of page.convos) {
        for (const member of convo.members) {
          if (member.did === did) {
            yield member
          }
        }
      }
    }
  }
}
