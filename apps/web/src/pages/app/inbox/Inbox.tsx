import { useParams } from 'react-router';
import { Inbox as InboxIcon } from 'lucide-react';
import { EmptyState } from '@/components/ui/misc';
import { ConversationList } from './ConversationList';
import { ChatPanel } from './ChatPanel';

/**
 * Team inbox: conversation list, chat and contact details.
 * Mobile shows the list first; opening a chat takes the full screen and a back button returns to the list.
 */
export default function Inbox() {
  const { conversationId } = useParams();
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-wa-bg">
      <ConversationList activeId={conversationId} />
      {conversationId ? <ChatPanel key={conversationId} id={conversationId} /> : (
        <div className="hidden flex-1 items-center justify-center bg-wa-wallpaper md:flex">
          <EmptyState icon={<InboxIcon />} title="Select a conversation" description="Customer messages from WhatsApp appear here in real time." />
        </div>
      )}
    </div>
  );
}
