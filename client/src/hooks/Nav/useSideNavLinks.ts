import { useMemo } from 'react';
import { MessageSquareQuote, ArrowRightToLine, Settings2, Bookmark, GitBranch } from 'lucide-react';
import {
  isAssistantsEndpoint,
  isAgentsEndpoint,
  PermissionTypes,
  isParamEndpoint,
  EModelEndpoint,
  Permissions,
} from 'librechat-data-provider';
import type { TConfig, TInterfaceConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import BookmarkPanel from '~/components/SidePanel/Bookmarks/BookmarkPanel';
import PanelSwitch from '~/components/SidePanel/Builder/PanelSwitch';
import AgentPanelSwitch from '~/components/SidePanel/Agents/AgentPanelSwitch';
import PromptsAccordion from '~/components/Prompts/PromptsAccordion';
import Parameters from '~/components/SidePanel/Parameters/Panel';
import FilesPanel from '~/components/SidePanel/Files/Panel';
import { Blocks, AttachmentIcon } from '~/components/svg';
import { useHasAccess } from '~/hooks';
import GraphPanel from '~/components/Knowledge/GraphPanel';

export default function useSideNavLinks({
  hidePanel,
  assistants,
  agents,
  keyProvided,
  endpoint,
  endpointType,
  interfaceConfig,
}: {
  hidePanel: () => void;
  assistants?: TConfig | null;
  agents?: TConfig | null;
  keyProvided: boolean;
  endpoint?: EModelEndpoint | null;
  endpointType?: EModelEndpoint | null;
  interfaceConfig: Partial<TInterfaceConfig>;
}) {
  const hasAccessToPrompts = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const Links = useMemo(() => {
    // Show only Knowledge Graph in the right panel
    const graphOnly: NavLink[] = [
      {
        title: 'com_sidepanel_knowledge_graph',
        label: '',
        icon: GitBranch,
        id: 'knowledge-graph',
        Component: GraphPanel,
      },
    ];
    return graphOnly;
  }, [
    interfaceConfig.parameters,
    keyProvided,
    assistants,
    endpointType,
    endpoint,
    agents,
    hasAccessToPrompts,
    hasAccessToBookmarks,
    hidePanel,
  ]);

  return Links;
}
