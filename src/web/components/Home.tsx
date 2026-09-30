import { GettingStarted } from "alepha/react/intro";

export interface HomeProps {
  appName: string;
  serverTime: string;
}

const Home = (props: HomeProps) => {
  return <GettingStarted welcome={props} />;
};

export default Home;
